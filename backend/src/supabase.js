// background-scripts/supabase.js

import {
    SUPABASE_EDGE_FUNCTION_URL,
    SUPABASE_FUNCTION_HEADERS,
    SUPABASE_LOG_BODY_PREVIEW_LIMIT
} from './config.js';
import { normalizeEmail } from './utils.js';
import { buildTaskPayloads } from '../workflowUtils.js';

let supabaseRequestSeq = 0;

export async function invokeSupabaseEdge(action, payload = {}, context = '') {
    const requestId = ++supabaseRequestSeq;

    let payloadPreview = null;
    try {
        payloadPreview = JSON.stringify(payload).slice(0, SUPABASE_LOG_BODY_PREVIEW_LIMIT);
    } catch (err) {
        payloadPreview = `[unserializable payload: ${err?.message || err}]`;
    }

    console.log(`[SupabaseEdge][${requestId}] Request${context ? ` (${context})` : ''}:`, {
        action,
        payloadPreview
    });

    const started = Date.now();
    let response;
    try {
        response = await directSupabaseEdgeFetch(action, payload);
    } catch (err) {
        const elapsed = Date.now() - started;
        console.error(`[SupabaseEdge][${requestId}] Request failed${context ? ` (${context})` : ''}:`, {
            elapsedMs: elapsed,
            message: err?.message,
            stack: err?.stack || null
        });
        throw err;
    }

    const elapsed = Date.now() - started;
    let responsePreview = '';
    try {
        if (typeof response?._bodyPreview === 'string') {
            responsePreview = response._bodyPreview;
        } else {
            const previewSource = response?.data ?? (response?.error
                ? {
                    ...response.error,
                    message: response.error.message,
                    name: response.error.name,
                    context: response.error.context
                }
                : null);
            const rawPreview = JSON.stringify(previewSource);
            responsePreview = rawPreview ? rawPreview.slice(0, SUPABASE_LOG_BODY_PREVIEW_LIMIT) : '';
        }
    } catch (err) {
        responsePreview = `[unable to read body: ${err?.message || err}]`;
    }

    const status = typeof response?.status === 'number'
        ? response.status
        : typeof response?.error?.status === 'number'
            ? response.error.status
            : undefined;

    console.log(`[SupabaseEdge][${requestId}] Response${context ? ` (${context})` : ''}:`, {
        status,
        ok: response?.data?.ok ?? !response?.error,
        elapsedMs: elapsed,
        bodyPreview: responsePreview,
        transport: 'direct-fetch'
    });

    if (response?.error) {
        return {
            httpStatus: status ?? 500,
            ok: false,
            error: response.error?.message || 'supabase-edge-error',
            details: response.error
        };
    }

    if (response?.data && typeof response.data === 'object') {
        return {
            httpStatus: status ?? 200,
            ...response.data
        };
    }

    return {
        httpStatus: status ?? 200,
        ok: true,
        data: response?.data ?? null
    };
}

async function directSupabaseEdgeFetch(action, payload) {
    let res;
    try {
        res = await fetch(SUPABASE_EDGE_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...SUPABASE_FUNCTION_HEADERS
            },
            body: JSON.stringify({ action, payload }),
            cache: 'no-store'
        });
    } catch (err) {
        const wrapped = new Error('Failed to send a request to the Edge Function');
        wrapped.cause = err;
        throw wrapped;
    }

    let text = '';
    try {
        const clone = res.clone();
        text = await clone.text();
    } catch (err) {
        text = '';
    }

    const preview = text ? text.slice(0, SUPABASE_LOG_BODY_PREVIEW_LIMIT) : '';

    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (err) {
            data = null;
        }
    }

    if (!res.ok) {
        const message = (data && typeof data === 'object'
            ? data?.message || data?.error
            : null) || text || `HTTP ${res.status}`;

        return {
            status: res.status,
            error: {
                name: 'HttpError',
                status: res.status,
                message,
                context: data && typeof data === 'object' ? data : { raw: text || null }
            },
            data: data && typeof data === 'object' ? data : null,
            _bodyPreview: preview
        };
    }

    return {
        status: res.status,
        data: data ?? null,
        _bodyPreview: preview
    };
}

export async function fetchSupabasePartners() {
    const result = await invokeSupabaseEdge('list_partners', {}, 'partners:list');

    if (!result?.ok) {
        const message = result?.error || `Supabase partners request failed with ${result?.httpStatus}`;
        throw new Error(message);
    }

    const rows = Array.isArray(result?.data) ? result.data : [];
    if (!Array.isArray(rows)) return [];

    return rows
        .map(partner => ({
            id: partner?.id ?? null,
            name: partner?.name ?? '',
            email: partner?.email ?? ''
        }))
        .filter(p => p.name && p.email);
}

export async function ensureSupabaseUser(user = {}) {
    const email = String(user.email || '').trim().toLowerCase();
    if (!email) return null;

    const name = String(user.name || '').trim() || email;
    const rawLinkedIn = String(user.linkedin || '').trim();
    const linkedin = rawLinkedIn || null;

    try {
        const result = await invokeSupabaseEdge('ensure_user', { email, name, linkedin }, 'users:ensure');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Supabase user ensure failed:', result?.error || result?.httpStatus);
            return null;
        }

        return result?.data?.id || null;
    } catch (err) {
        console.warn('[Specter-Outreach] Supabase user insert error:', err);
        return null;
    }
}

export async function insertTaskRecords(payload = {}) {
    const companyId = payload.companyId || payload.company_id;
    const steps = Array.isArray(payload.steps) ? payload.steps
        : Array.isArray(payload.tasks) ? payload.tasks : [];
    if (!companyId || !steps.length) {
        return { ok: true, data: [] };
    }

    const userId = await ensureSupabaseUser(payload.user || {});
    if (!userId) {
        return {
            ok: false,
            error: 'supabase-user-missing',
            details: 'User could not be located or created in Supabase.'
        };
    }
    const fallbackPartnerId = payload.fallbackPartnerId || null;

    const taskPayloads = buildTaskPayloads({
        companyId,
        userId,
        steps,
        fallbackPartnerId
    });

    if (!taskPayloads.length) {
        return { ok: true, data: [] };
    }

    try {
        const result = await invokeSupabaseEdge('insert_tasks', { tasks: taskPayloads }, 'tasks:insert');
        if (!result?.ok) {
            return { ok: false, error: result?.error || `supabase-${result?.httpStatus}`, details: result?.details || null };
        }

        const body = Array.isArray(result?.data) ? result.data : [];
        return { ok: true, data: body };
    } catch (err) {
        console.warn('[Specter-Outreach] Supabase task insert failed:', err);
        return { ok: false, error: err.message };
    }
}

export async function fetchCompanyByDomainOrName({ domain, companyName }) {
    if (!domain && !companyName) return null;

    try {
        const result = await invokeSupabaseEdge('fetch_company_by_domain_or_name', { domain, companyName }, 'companies:lookup');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Company lookup failed:', result?.error || result?.httpStatus);
            return null;
        }
        return result?.data || null;
    } catch (err) {
        console.warn('[Specter-Outreach] Company lookup failed:', err);
        return null;
    }
}

export async function fetchCompanyTasks(companyId) {
    if (!companyId) return [];

    try {
        const result = await invokeSupabaseEdge('fetch_company_tasks', { companyId }, 'tasks:company-tasks');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Company tasks request failed:', result?.error || result?.httpStatus);
            return [];
        }
        const rows = Array.isArray(result?.data) ? result.data : [];
        return rows;
    } catch (err) {
        console.warn('[Specter-Outreach] Company tasks fetch error:', err);
        return [];
    }
}

export async function fetchCompanyById(companyId) {
    if (!companyId) return null;

    try {
        const result = await invokeSupabaseEdge('fetch_company_by_id', { companyId }, 'companies:lookup-by-id');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Company lookup failed:', result?.error || result?.httpStatus);
            return null;
        }
        return result?.data || null;
    } catch (err) {
        console.warn('[Specter-Outreach] Company fetch error:', err);
    }
    return null;
}

export async function fetchOutstandingTasks({ excludeCompanyId = null, userId = null, userEmail = null } = {}) {
    if (!userId) return [];
    const normalizedEmail = normalizeEmail(userEmail);

    try {
        const result = await invokeSupabaseEdge('fetch_outstanding_tasks', { excludeCompanyId, userId, userEmail }, 'tasks:outstanding');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Outstanding tasks request failed:', result?.error || result?.httpStatus);
            return [];
        }
        const rows = Array.isArray(result?.data) ? result.data : [];
        if (!normalizedEmail) {
            return rows;
        }
        return rows.map(row => {
            if (!row || typeof row !== 'object') return row;
            const { assignee, ...rest } = row;
            return rest;
        });
    } catch (err) {
        console.warn('[Specter-Outreach] Outstanding tasks fetch error:', err);
        return [];
    }
}

export async function fetchOverdueTasks({ userId = null, userEmail = null, limit = 20 } = {}) {
    if (!userId) return [];

    const normalizedEmail = normalizeEmail(userEmail);
    try {
        const result = await invokeSupabaseEdge('fetch_overdue_tasks', { userId, userEmail, limit }, 'tasks:upcoming');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Overdue tasks request failed:', result?.error || result?.httpStatus);
            return [];
        }
        const rows = Array.isArray(result?.data) ? result.data : [];
        if (!normalizedEmail) {
            return rows;
        }
        return rows.map(row => {
            if (!row || typeof row !== 'object') return row;
            const { assignee, ...rest } = row;
            return rest;
        });
    } catch (err) {
        console.warn('[Specter-Outreach] Overdue tasks fetch error:', err);
        return [];
    }
}

export async function fetchUpcomingTasksForUser({ userId = null, userEmail = null, limit = 40 } = {}) {
    if (!userId) return [];

    const normalizedEmail = normalizeEmail(userEmail);
    try {
        const result = await invokeSupabaseEdge('fetch_upcoming_tasks', { userId, userEmail, limit }, 'tasks:upcoming-future');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Upcoming tasks request failed:', result?.error || result?.httpStatus);
            return [];
        }
        const rows = Array.isArray(result?.data) ? result.data : [];
        if (!normalizedEmail) {
            return rows;
        }
        return rows.map(row => {
            if (!row || typeof row !== 'object') return row;
            const { assignee, ...rest } = row;
            return rest;
        });
    } catch (err) {
        console.warn('[Specter-Outreach] Upcoming tasks fetch error:', err);
        return [];
    }
}

export async function deleteSupabaseTask(taskId) {
    if (!taskId) return false;

    try {
        const result = await invokeSupabaseEdge('delete_task', { taskId }, 'tasks:delete');
        if (!result?.ok) {
            console.warn('[Specter-Outreach] Failed to delete Supabase task', taskId, result?.error || result?.httpStatus, result?.details || null);
            return false;
        }
        return !!result?.data?.deleted;
    } catch (err) {
        console.warn('[Specter-Outreach] Supabase task delete error:', err);
        return false;
    }
}

export async function insertCompanyRecord(payload) {
    const name = String(payload?.name || '').trim();
    const website = payload?.website ? String(payload.website).trim() : null;
    const contact = String(payload?.contact_person || '').trim();
    const email = String(payload?.email || '').trim();
    const linkedin = payload?.linkedin ? String(payload.linkedin).trim() : null;

    if (!name || !contact || !email) {
        return { ok: false, error: 'missing-required-fields' };
    }

    try {
        const result = await invokeSupabaseEdge('insert_company', {
            name,
            website,
            contact_person: contact,
            email,
            linkedin
        }, 'companies:insert');

        if (!result?.ok) {
            return { ok: false, error: result?.error || `supabase-${result?.httpStatus}`, details: result?.details || null };
        }

        return { ok: true, data: result?.data || null };
    } catch (err) {
        console.warn('[Specter-Outreach] Supabase insert failed:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * Aggregates company info, specific company tasks, and general outstanding pipeline tasks
 * to return a full snapshot for the UI.
 */
export async function fetchWorkflowSnapshot(payload = {}) {
    const { domain, companyName, user } = payload;
    
    try {
        // 1. Resolve Company
        const company = await fetchCompanyByDomainOrName({ domain, companyName });
        
        // 2. Resolve User
        // We ensure the user exists so we can get their ID for the outstanding tasks query
        const userId = user ? await ensureSupabaseUser(user) : null;
        const userEmail = user?.email || null;

        // 3. Fetch Company Tasks (if company exists)
        let tasks = [];
        if (company && company.id) {
            tasks = await fetchCompanyTasks(company.id);
        }

        // 4. Fetch Outstanding Pipeline (excluding current company)
        // This populates the "Pipeline - other companies" section
        const outstandingTasks = await fetchOutstandingTasks({ 
            excludeCompanyId: company?.id || null, 
            userId,
            userEmail 
        });

        return {
            ok: true,
            data: {
                company,
                tasks,
                outstandingTasks,
                fallbackPartnerId: null
            }
        };
    } catch (err) {
        console.warn('[Specter-Outreach] fetchWorkflowSnapshot failed:', err);
        return { ok: false, error: err.message };
    }
}