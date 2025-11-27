// background-scripts/affinity.js

import { AFFINITY_API_BASE_URL, AFFINITY_API_KEY, AFFINITY_REQUEST_TIMEOUT_MS } from './config.js';

const affinityCache = {
    dealPipelineListId: null,
    dealPipelineStatusField: null,
    dealPipelineStatusOptions: null
};

export function ensureAffinityConfigured() {
    if (!AFFINITY_API_KEY || AFFINITY_API_KEY === 'PUT_REAL_AFFINITY_API_KEY_HERE') {
        throw new Error('Affinity API key not configured. Update background.js with a valid key.');
    }
}

export function normalizeDomain(domain) {
    if (!domain) return '';
    try {
        const url = new URL(domain.startsWith('http') ? domain : `https://${domain}`);
        domain = url.hostname;
    } catch (_) {
    }
    return domain.trim().toLowerCase().replace(/^www\./, '');
}

export function domainsMatch(candidate, target) {
    const normalizedTarget = normalizeDomain(target);
    if (!normalizedTarget) return false;
    const primary = normalizeDomain(candidate?.domain);
    if (primary && primary === normalizedTarget) return true;
    if (Array.isArray(candidate?.domains)) {
        return candidate.domains.some(d => normalizeDomain(d) === normalizedTarget);
    }
    return false;
}

export async function affinityFetch(
    path,
    { method = 'GET', query, headers = {}, body, timeoutMs = AFFINITY_REQUEST_TIMEOUT_MS, retries = 3 } = {}
) {
    ensureAffinityConfigured();

    const url = new URL(path, AFFINITY_API_BASE_URL);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === '') continue;
            url.searchParams.append(key, value);
        }
    }

    let attempt = 0;
    let backoffMs = 1000;

    while (true) {
        const controller = new AbortController();
        const abortTimer = setTimeout(
            () => controller.abort(new Error('Affinity request timed out')),
            Math.max(1, timeoutMs)
        );

        const requestHeaders = { ...headers, Authorization: 'Basic ' + btoa(':' + AFFINITY_API_KEY) };
        const fetchOptions = { method, headers: requestHeaders, signal: controller.signal };

        if (body !== undefined && body !== null) {
            if (
                body instanceof URLSearchParams ||
                (typeof FormData !== 'undefined' && body instanceof FormData) ||
                typeof body === 'string'
            ) {
                fetchOptions.body = body;
            } else {
                fetchOptions.body = JSON.stringify(body);
                if (!fetchOptions.headers['Content-Type']) {
                    fetchOptions.headers['Content-Type'] = 'application/json';
                }
            }
        }

        let res;
        try {
            res = await fetch(url.toString(), fetchOptions);
        } catch (e) {
            clearTimeout(abortTimer);
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, backoffMs));
                attempt++; backoffMs *= 2;
                continue;
            }
            throw e;
        } finally {
            clearTimeout(abortTimer);
        }

        if (!res.ok) {
            if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
                await new Promise(r => setTimeout(r, backoffMs));
                attempt++; backoffMs *= 2;
                continue;
            }
            const errorText = await res.text();
            throw new Error(`Affinity API ${method} ${url.pathname} failed: ${res.status} ${errorText || res.statusText}`);
        }

        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch (err) {
            console.error('[Specter-Outreach] Failed to parse Affinity response JSON', err, text);
            throw err;
        }
    }
}

export async function getDealPipelineMetadata() {
    if (affinityCache.dealPipelineListId && affinityCache.dealPipelineStatusField && affinityCache.dealPipelineStatusOptions) {
        return {
            listId: affinityCache.dealPipelineListId,
            statusField: affinityCache.dealPipelineStatusField,
            statusOptions: affinityCache.dealPipelineStatusOptions
        };
    }

    const listsData = await affinityFetch('/lists');
    const lists = Array.isArray(listsData) ? listsData : listsData?.lists || [];
    const dealPipeline = lists.find(list => (list.name || '').toLowerCase() === 'deal pipeline');
    if (!dealPipeline) {
        throw new Error('Deal Pipeline list not found in Affinity.');
    }

    const fieldsData = await affinityFetch('/fields', { query: { list_id: dealPipeline.id } });
    const fields = Array.isArray(fieldsData) ? fieldsData : fieldsData?.fields || [];
    const statusField = fields.find(field => (field.name || '').toLowerCase() === 'status');
    if (!statusField) {
        throw new Error('Status field not found on Deal Pipeline list.');
    }

    const optionMap = new Map();
    if (Array.isArray(statusField.dropdown_options)) {
        for (const opt of statusField.dropdown_options) {
            optionMap.set(opt.id, opt);
        }
    }

    affinityCache.dealPipelineListId = dealPipeline.id;
    affinityCache.dealPipelineStatusField = statusField;
    affinityCache.dealPipelineStatusOptions = optionMap;

    return {
        listId: dealPipeline.id,
        statusField,
        statusOptions: optionMap
    };
}

export async function findAffinityOrganization({ domain, name }) {
    const term = normalizeDomain(domain) || (name || '').trim();
    if (!term) return null;

    const data = await affinityFetch('/organizations', { query: { term } });
    const organizations = Array.isArray(data) ? data : (data?.organizations || []);
    const chosen = organizations[0] || null;

    console.info('[Affinity] search term:', term, '→ first org:', chosen ? {
        id: chosen.id,
        name: chosen.name,
        domain: chosen.domain || (Array.isArray(chosen.domains) ? chosen.domains[0] : null),
    } : null);

    return chosen;
}

export async function getListEntryForOrganization(listId, organizationId) {
    let pageToken;
    do {
        const data = await affinityFetch(`/lists/${listId}/list-entries`, { query: { page_size: 200, page_token: pageToken } });
        const entries = Array.isArray(data) ? data : data?.list_entries || [];
        const match = entries.find(entry => entry.entity_id === organizationId);
        if (match) return match;
        pageToken = data?.next_page_token;
    } while (pageToken);
    return null;
}

export async function getStatusForListEntry(statusFieldId, listEntryId, statusOptions) {
    const data = await affinityFetch('/field-values', { query: { list_entry_id: listEntryId } });
    const values = Array.isArray(data) ? data : data?.field_values || [];
    const statusValue = values.find(value => value.field_id === statusFieldId);
    if (!statusValue) return null;

    const rawValue = statusValue.value;
    if (rawValue && typeof rawValue === 'object' && 'text' in rawValue) {
        return {
            text: rawValue.text,
            optionId: rawValue.id || null,
            color: rawValue.color ?? null
        };
    }

    if (statusOptions instanceof Map && statusOptions.size && (rawValue?.id || rawValue)) {
        const option = statusOptions.get(rawValue.id || rawValue);
        if (option) {
            return {
                text: option.text,
                optionId: option.id,
                color: option.color ?? null
            };
        }
    }

    if (rawValue === null || rawValue === undefined) return null;

    return {
        text: String(rawValue),
        optionId: null,
        color: null
    };
}

export async function getDealPipelineStatus({ domain, name }) {
    try {
        const identifiers = { domain: normalizeDomain(domain), name };
        const { listId, statusField, statusOptions } = await getDealPipelineMetadata();
        const organization = await findAffinityOrganization(identifiers);

        if (!organization) {
            console.warn('[Affinity] No organization resolved for:', identifiers);
            return { inPipeline: false, organization: null };
        }

        console.info('[Affinity] Status check for org:', {
            id: organization.id,
            name: organization.name,
            domain: organization.domain || (organization.domains?.[0] || null),
            listId,
        });

        const listEntry = await getListEntryForOrganization(listId, organization.id);
        if (!listEntry) {
            return { inPipeline: false, organization };
        }

        const status = await getStatusForListEntry(statusField.id, listEntry.id, statusOptions);

        console.info('[Affinity] Pipeline status:', {
            orgId: organization.id,
            listEntryId: listEntry.id,
            status: status?.text || null,
        });

        return { inPipeline: true, organization, listEntry, status };
    } catch (err) {
        console.warn('[Affinity] Status lookup failed/timeout:', err?.message || err);
        return { inPipeline: false, organization: null, error: 'timeout_or_error' };
    }
}

export async function addOrganizationToDealPipeline({ domain, name }) {
    const identifiers = { domain: normalizeDomain(domain), name };
    if (!identifiers.domain && !identifiers.name) {
        throw new Error('A company name or domain is required to add to the Deal Pipeline.');
    }

    const { listId } = await getDealPipelineMetadata();
    let organization = await findAffinityOrganization(identifiers);

    if (!organization) {
        const payload = { name: identifiers.name };
        if (identifiers.domain) payload.domain = identifiers.domain;
        organization = await affinityFetch('/organizations', { method: 'POST', body: payload });

        console.info('[Affinity] Created organization:', {
            id: organization?.id, name: organization?.name, domain: organization?.domain || null,
        });
    } else {
        console.info('[Affinity] Matched organization:', {
            id: organization.id, name: organization.name, domain: organization.domain || (organization.domains?.[0] || null),
        });
    }

    const existingEntry = await getListEntryForOrganization(listId, organization.id);
    if (existingEntry) {
        console.info('[Affinity] Already on list:', { orgId: organization.id, listEntryId: existingEntry.id, listId });
        return { added: false, alreadyPresent: true, organization, listEntry: existingEntry };
    }

    const body = new URLSearchParams({ entity_id: String(organization.id) });
    const listEntry = await affinityFetch(`/lists/${listId}/list-entries`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.info('[Affinity] Added to list:', { orgId: organization.id, listEntryId: listEntry?.id, listId });

    return { added: true, organization, listEntry };
}
