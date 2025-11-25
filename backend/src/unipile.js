// background-scripts/unipile.js

import { UNIPILE_API_KEY, UNIPILE_API_URL, LINKEDIN_PROFILE_CACHE_TTL_MS, LINKEDIN_CHAT_CACHE_TTL_MS } from './config.js';
import { invokeSupabaseEdge } from './supabase.js';

const linkedInProfileCache = new Map();
const linkedInProfilePromiseCache = new Map();
const linkedInChatCacheByAccount = new Map();
const linkedInChatCachePromises = new Map();

export function extractLinkedInIdentifier(value) {
    if (!value) return null;
    let raw = String(value).trim();
    if (!raw) return null;

    if (/^mailto:/i.test(raw)) {
        raw = raw.replace(/^mailto:/i, '').trim();
    }

    if (/^https?:/i.test(raw)) {
        try {
            const url = new URL(raw);
            const segments = url.pathname.split('/').filter(Boolean);
            raw = segments.length ? segments[segments.length - 1] : '';
        } catch (err) {
            console.warn('[Specter-Outreach] Invalid LinkedIn URL provided:', value, err);
            raw = raw.replace(/^https?:\/\//i, '');
        }
    }

    raw = raw.replace(/[?#].*$/, '');
    raw = raw.replace(/^in\//i, '');
    raw = raw.replace(/^company\//i, '');
    raw = raw.replace(/^\/+|\/+$/g, '');

    if (!raw) return null;

    if (/@/.test(raw)) {
        return null;
    }

    if (!raw) return null;
    return raw;
}

export function canonicalizeLinkedInProfileUrl(value) {
    if (value === undefined || value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const looksLikeUrl = /linkedin\.com/i.test(raw) || /^https?:/i.test(raw) || /^www\./i.test(raw);
    const looksLikeSlug = /^in\//i.test(raw) || /^[a-z0-9][a-z0-9-_]{1,100}$/i.test(raw);
    if (!looksLikeUrl && !looksLikeSlug) return null;
    const identifier = extractLinkedInIdentifier(raw);
    if (!identifier) return null;
    return `https://www.linkedin.com/in/${identifier}`;
}

export function isLinkedInAccount(account = {}) {
    const provider = String(account?.provider || account?.type || '').toUpperCase();
    return provider === 'LINKEDIN';
}

export function enrichUnipileAccount(account = {}) {
    if (!account) return account;

    const normalized = { ...account };
    if (!isLinkedInAccount(normalized)) {
        return normalized;
    }

    const profile = { ...(normalized.profile || {}) };
    const connectionParams = normalized.connection_params || normalized.connectionParams || {};
    const im = connectionParams.im || connectionParams.IM || connectionParams.linkedin || connectionParams.LINKEDIN || null;

    if (im) {
        if (im.username && !profile.full_name) profile.full_name = im.username;
        if (im.name && !profile.full_name) profile.full_name = im.name;
        if (im.firstName && !profile.first_name) profile.first_name = im.firstName;
        if (im.lastName && !profile.last_name) profile.last_name = im.lastName;
        if (im.displayName && !profile.display_name) profile.display_name = im.displayName;
    }

    const identifierCandidates = [
        profile.linkedin_url,
        profile.linkedinUrl,
        profile.profile_url,
        profile.profileUrl,
        profile.public_identifier,
        profile.publicIdentifier,
        normalized.public_identifier,
        normalized.publicIdentifier,
        im?.publicIdentifier,
        im?.public_identifier,
        im?.publicId,
        im?.public_id,
        im?.profileUrl,
        im?.profile_url,
        im?.id,
        im?.username
    ];

    let resolvedSlug = null;
    let resolvedUrl = null;

    for (const candidate of identifierCandidates) {
        if (!candidate) continue;
        const urlCandidate = canonicalizeLinkedInProfileUrl(candidate);
        if (urlCandidate) {
            resolvedUrl = urlCandidate;
            resolvedSlug = extractLinkedInIdentifier(urlCandidate);
            break;
        }

        const slug = extractLinkedInIdentifier(candidate);
        if (slug) {
            resolvedSlug = slug;
            const urlFromSlug = canonicalizeLinkedInProfileUrl(slug);
            if (urlFromSlug) {
                resolvedUrl = urlFromSlug;
            }
            break;
        }
    }

    if (resolvedSlug) {
        if (!profile.public_identifier) profile.public_identifier = resolvedSlug;
        if (!profile.publicIdentifier) profile.publicIdentifier = resolvedSlug;
    }

    if (resolvedUrl) {
        if (!profile.linkedin_url) profile.linkedin_url = resolvedUrl;
        if (!profile.linkedinUrl) profile.linkedinUrl = resolvedUrl;
        if (!profile.profile_url) profile.profile_url = resolvedUrl;
        if (!profile.profileUrl) profile.profileUrl = resolvedUrl;
    }

    if (!normalized.display_name && (profile.full_name || profile.display_name)) {
        normalized.display_name = profile.full_name || profile.display_name;
    }
    if (!normalized.name && profile.full_name) {
        normalized.name = profile.full_name;
    }

    if (Object.keys(profile).length) {
        normalized.profile = profile;
    }

    return normalized;
}

export async function fetchUnipileLinkedInProfile(accountId, identifier, { forceRefresh = false } = {}) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) return null;
    if (!accountId || !identifier) return null;

    const cacheKey = `${accountId}:${identifier}`.toLowerCase();
    const now = Date.now();

    if (!forceRefresh && cacheKey) {
        const cached = linkedInProfileCache.get(cacheKey);
        if (cached && now - cached.fetchedAt < LINKEDIN_PROFILE_CACHE_TTL_MS) {
            return cached.profile;
        }

        const inFlight = linkedInProfilePromiseCache.get(cacheKey);
        if (inFlight) {
            return inFlight;
        }
    }

    const fetchPromise = (async () => {
        const url = new URL(`${UNIPILE_API_URL}/api/v1/users/${encodeURIComponent(identifier)}`);
        url.searchParams.set('account_id', accountId);
        url.searchParams.set('linkedin_sections', '*');

        try {
            const res = await fetch(url.toString(), {
                headers: {
                    'X-API-KEY': UNIPILE_API_KEY,
                    accept: 'application/json'
                }
            });

            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                if (res.status === 422) {
                    let body = null;
                    try {
                        body = txt ? JSON.parse(txt) : null;
                    } catch (_) {
                        body = txt || null;
                    }
                    console.info('[Specter-Outreach][Debug] LinkedIn profile marked unreachable', {
                        status: res.status,
                        accountId,
                        identifier,
                        body
                    });
                } else {
                    console.warn('[Specter-Outreach] LinkedIn profile fetch failed:', res.status, txt);
                }
                return null;
            }

            return await res.json().catch(() => null);
        } catch (err) {
            console.warn('[Specter-Outreach] LinkedIn profile fetch error:', err);
            return null;
        }
    })().finally(() => {
        linkedInProfilePromiseCache.delete(cacheKey);
    });

    if (!forceRefresh && cacheKey) {
        linkedInProfilePromiseCache.set(cacheKey, fetchPromise);
    }

    const profile = await fetchPromise;
    if (!forceRefresh && cacheKey) {
        linkedInProfileCache.set(cacheKey, { profile, fetchedAt: Date.now() });
    }
    return profile;
}

export function slugifyLinkedInName(value) {
    if (!value) return null;
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || null;
}

export function normalizeLinkedInChatCandidate(chat) {
    if (!chat) return null;

    const chatId = chat?.id ?? chat?.chat_id ?? chat?.uuid ?? null;
    const provider = chat?.provider ?? chat?.channel ?? null;
    const providerId = chat?.provider_id ?? chat?.providerId ?? null;
    const attendeeProviderId = chat?.attendee_provider_id ?? chat?.attendeeProviderId ?? null;
    const rawName = typeof chat?.name === 'string' ? chat.name : null;
    const normalizedName = rawName ? rawName.trim().toLowerCase() : null;

    return {
        chatId: chatId ? String(chatId).trim() : null,
        provider: provider || null,
        providerId: providerId ? String(providerId).trim().toLowerCase() : null,
        attendeeProviderId: attendeeProviderId ? String(attendeeProviderId).trim().toLowerCase() : null,
        nameSlug: normalizedName ? slugifyLinkedInName(normalizedName) : null,
    };
}

export function buildLinkedInChatSample(chats) {
    return chats.slice(0, 3).map(chat => ({
        id: chat?.id ?? chat?.chat_id ?? chat?.uuid ?? null,
        provider_id: chat?.provider_id ?? chat?.providerId ?? null,
        attendee_provider_id: chat?.attendee_provider_id ?? chat?.attendeeProviderId ?? null,
        name: chat?.name ?? null
    }));
}

export async function fetchLinkedInChatsForAccount(accountId, logContext = {}) {
    const url = new URL(`${UNIPILE_API_URL}/api/v1/chats`);
    url.searchParams.set('account_id', accountId);
    url.searchParams.set('provider', 'LINKEDIN');
    url.searchParams.set('limit', '100');

    console.log('[Specter-Outreach][Debug] Fetching LinkedIn chats for lookup', {
        accountId,
        ...logContext
    });

    try {
        const res = await fetch(url.toString(), {
            headers: {
                'X-API-KEY': UNIPILE_API_KEY,
                accept: 'application/json'
            }
        });

        if (!res.ok) {
            console.warn('[Specter-Outreach][Debug] LinkedIn chats lookup failed', { status: res.status });
            return { chats: [], raw: [] };
        }

        const body = await res.json().catch(() => ({}));
        const candidates = Array.isArray(body?.data) ? body.data
            : Array.isArray(body?.items) ? body.items
                : Array.isArray(body?.chats) ? body.chats
                    : Array.isArray(body) ? body : [];

        console.log('[Specter-Outreach][Debug] LinkedIn chat lookup received candidates', {
            count: candidates.length,
            sample: buildLinkedInChatSample(candidates)
        });

        const normalizedChats = candidates
            .map(normalizeLinkedInChatCandidate)
            .filter(chat => chat && chat.chatId)
            .filter(chat => !chat.provider || String(chat.provider).toUpperCase() === 'LINKEDIN');

        return { chats: normalizedChats, raw: candidates };
    } catch (err) {
        console.warn('[Specter-Outreach][Debug] LinkedIn chats lookup error', err);
        return { chats: [], raw: [] };
    }
}

export async function getLinkedInChats(accountId, { forceRefresh = false, logContext = {} } = {}) {
    const key = String(accountId || '').trim();
    if (!key) {
        return { chats: [], fetchedAt: Date.now() };
    }

    if (!forceRefresh) {
        const cached = linkedInChatCacheByAccount.get(key);
        if (cached && Date.now() - cached.fetchedAt < LINKEDIN_CHAT_CACHE_TTL_MS) {
            return cached;
        }

        const inFlight = linkedInChatCachePromises.get(key);
        if (inFlight) {
            return inFlight;
        }
    }

    const fetchPromise = (async () => {
        const { chats } = await fetchLinkedInChatsForAccount(key, logContext);
        const record = { chats, fetchedAt: Date.now() };
        linkedInChatCacheByAccount.set(key, record);
        return record;
    })()
        .finally(() => {
            linkedInChatCachePromises.delete(key);
        });

    linkedInChatCachePromises.set(key, fetchPromise);
    return fetchPromise;
}

export async function findLinkedInChatId(accountId, providerId, options = {}) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) {
        console.log('[Specter-Outreach][Debug] LinkedIn chat lookup skipped – missing Unipile configuration');
        return null;
    }

    if (!accountId || !providerId) {
        console.log('[Specter-Outreach][Debug] LinkedIn chat lookup skipped – missing account or provider', {
            accountId: accountId ?? null,
            providerId: providerId ?? null
        });
        return null;
    }

    const target = String(providerId).trim().toLowerCase();
    if (!target) {
        console.log('[Specter-Outreach][Debug] LinkedIn chat lookup skipped – empty provider after normalisation', { providerId });
        return null;
    }

    let cache = options?.preloadedChats || null;
    if (!cache) {
        cache = await getLinkedInChats(accountId, { logContext: { ...(options?.logContext || {}), providerId: target } });
    }

    const chats = Array.isArray(cache?.chats) ? cache.chats : [];
    const targetSlug = slugifyLinkedInName(target);

    for (const chat of chats) {
        if (!chat || !chat.chatId) continue;
        if (chat.provider && String(chat.provider).toUpperCase() !== 'LINKEDIN') {
            continue;
        }

        if (chat.providerId && chat.providerId === target) {
            console.log('[Specter-Outreach][Debug] LinkedIn chat match found', { chatId: chat.chatId, providerId: target });
            return chat.chatId;
        }

        if (chat.attendeeProviderId && chat.attendeeProviderId === target) {
            console.log('[Specter-Outreach][Debug] LinkedIn chat match found via attendee', {
                chatId: chat.chatId,
                providerId: target
            });
            return chat.chatId;
        }

        if (chat.nameSlug && targetSlug && (chat.nameSlug === targetSlug || target.startsWith(`${chat.nameSlug}-`))) {
            console.log('[Specter-Outreach][Debug] LinkedIn chat match found via name slug', {
                chatId: chat.chatId,
                providerId: target,
                nameSlug: chat.nameSlug
            });
            return chat.chatId;
        }
    }

    console.log('[Specter-Outreach][Debug] LinkedIn chat lookup finished without match', { providerId: target });
    return null;
}

export async function fetchLinkedInChatMessages(accountId, chatId, { limit = 50 } = {}) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) return [];
    if (!chatId) return [];

    const url = new URL(`${UNIPILE_API_URL}/api/v1/chats/${encodeURIComponent(chatId)}/messages`);
    if (limit) {
        url.searchParams.set('limit', String(limit));
    }
    if (accountId) {
        url.searchParams.set('account_id', accountId);
    }

    try {
        const res = await fetch(url.toString(), {
            headers: {
                'X-API-KEY': UNIPILE_API_KEY,
                accept: 'application/json'
            }
        });

        if (!res.ok) {
            console.warn('[Specter-Outreach] LinkedIn messages fetch failed:', res.status);
            return [];
        }

        const body = await res.json().catch(() => ({}));
        const list = Array.isArray(body?.data) ? body.data
            : Array.isArray(body?.items) ? body.items
                : Array.isArray(body?.messages) ? body.messages
                    : Array.isArray(body) ? body : [];
        return list;
    } catch (err) {
        console.warn('[Specter-Outreach] LinkedIn messages fetch error:', err);
        return [];
    }
}

export async function listUnipileAccounts() {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) return [];
    try {
        const res = await fetch(`${UNIPILE_API_URL}/api/v1/accounts`, {
            headers: {
                'X-API-KEY': UNIPILE_API_KEY,
                'accept': 'application/json'
            }
        });
        if (!res.ok) {
            const details = await res.text().catch(() => '');
            throw new Error(`unipile-accounts-${res.status}: ${details}`);
        }
        const data = await res.json().catch(() => ({}));
        const accounts = Array.isArray(data) ? data
            : Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.accounts) ? data.accounts
                    : Array.isArray(data?.items) ? data.items
                        : [];
        const normalizedAccounts = accounts.map(account => enrichUnipileAccount(account));
        console.log('[Unipile][list] fetched', normalizedAccounts.length, 'accounts');
        return normalizedAccounts;
    } catch (err) {
        console.warn('[Specter-Outreach] Unipile list accounts error:', err);
        return [];
    }
}

export function normalizeNameForMatch(val = '') {
    return String(val || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function accountMatchesProfile(account = {}, profile = {}) {
    const accountName = account.display_name || account.name || account.label || account.full_name || account.profile_name || '';
    const normalizedAccount = normalizeNameForMatch(accountName);
    if (!normalizedAccount) return false;

    const first = normalizeNameForMatch(profile.firstName || '');
    const last = normalizeNameForMatch(profile.lastName || '');
    const display = normalizeNameForMatch(profile.displayName || '');

    if (first && !normalizedAccount.includes(first)) return false;
    if (last && !normalizedAccount.includes(last)) return false;

    if (display) {
        const parts = display.split(' ').filter(Boolean);
        if (parts.length && parts.every(part => normalizedAccount.includes(part))) return true;
    }

    if (first && last) {
        return normalizedAccount.includes(first) && normalizedAccount.includes(last);
    }

    return !!first && normalizedAccount.includes(first);
}

export function findMatchingLinkedInAccount(accounts = [], profile = {}) {
    const linked = accounts.filter(isLinkedInAccount);
    const match = linked.find(acc => accountMatchesProfile(acc, profile));
    if (match) {
        console.log('[Unipile][match] Found match', { accountId: match.account_id || match.id || null, display_name: match.display_name || match.name || null, profile });
    } else {
        console.log('[Unipile][match] No match yet for profile', profile);
    }
    return match;
}

export async function createUnipileLinkedInLink(payload = {}) {
    if (!UNIPILE_API_KEY) {
        return { ok: false, error: 'unipile-api-key-not-configured' };
    }
    if (!UNIPILE_API_URL) {
        return { ok: false, error: 'unipile-api-url-not-configured' };
    }

    const profile = payload.user || {};
    console.log('[Unipile][createLink] Request received', { profile });
    const knownAccounts = await listUnipileAccounts();
    const linkedInAccounts = knownAccounts.filter(isLinkedInAccount);
    const knownAccountIds = linkedInAccounts
        .map(acc => acc?.account_id || acc?.id)
        .filter(Boolean);
    console.log('[Unipile][createLink] known LinkedIn accounts', knownAccountIds.length);

    const match = findMatchingLinkedInAccount(linkedInAccounts, profile);
    if (match) {
        console.log('[Unipile][createLink] Returning existing connection', { accountId: match.account_id || match.id || null });
        return {
            ok: true,
            accountId: match.account_id || match.id || null,
            alreadyConnected: true,
            knownAccountIds,
            account: match || null
        };
    }

    const expiresOn = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const body = {
        type: 'create',
        providers: ['LINKEDIN'],
        api_url: UNIPILE_API_URL,
        expiresOn
    };

    try {
        const res = await fetch(`${UNIPILE_API_URL}/api/v1/hosted/accounts/link`, {
            method: 'POST',
            headers: {
                'X-API-KEY': UNIPILE_API_KEY,
                'accept': 'application/json',
                'content-type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const details = await res.text().catch(() => '');
            console.warn('[Unipile][createLink] API returned error', res.status, details);
            return { ok: false, error: `unipile-${res.status}`, details, knownAccountIds };
        }

        const json = await res.json().catch(() => ({}));
        const url = json?.url || json?.data?.url || null;
        if (!url) {
            console.warn('[Unipile][createLink] Missing URL in response', json);
            return { ok: false, error: 'unipile-missing-url', details: json, knownAccountIds };
        }

        console.log('[Unipile][createLink] Hosted link generated');
        return { ok: true, url, knownAccountIds };
    } catch (err) {
        console.warn('[Specter-Outreach] Unipile hosted auth error:', err);
        return { ok: false, error: err.message, knownAccountIds };
    }
}

export function matchesUnipileAccountId(account, targetId) {
    if (!account || !targetId) return false;
    const normalizedTarget = String(targetId).trim();
    if (!normalizedTarget) return false;
    const candidates = [
        account?.account_id,
        account?.id,
        account?.accountId,
        account?.uid,
        account?.accountID
    ]
        .map(val => (val !== undefined && val !== null) ? String(val).trim() : '')
        .filter(Boolean);
    return candidates.includes(normalizedTarget);
}

export async function checkUnipileLinkedInAccount(payload = {}) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) {
        return { ok: false, error: 'unipile-not-configured', knownAccountIds: [] };
    }

    const profile = payload.user || {};
    const knownIds = Array.isArray(payload.knownAccountIds) ? payload.knownAccountIds : [];
    const accounts = await listUnipileAccounts();
    const linkedInAccounts = accounts.filter(isLinkedInAccount);
    const allIds = linkedInAccounts
        .map(acc => acc?.account_id || acc?.id)
        .filter(Boolean);
    console.log('[Unipile][check] LinkedIn accounts', { count: linkedInAccounts.length, allIds });

    const match = findMatchingLinkedInAccount(linkedInAccounts, profile);
    if (match) {
        const accountId = match.account_id || match.id || null;
        if (accountId) {
            console.log('[Unipile][check] Match found during polling', { accountId });
            return { ok: true, accountId, knownAccountIds: allIds, account: match || null };
        }
    }

    const newAccountId = allIds.find(id => !knownIds.includes(id));
    if (newAccountId) {
        console.log('[Unipile][check] New account detected (no match)', { accountId: newAccountId });
        const fallbackAccount = linkedInAccounts.find(acc => matchesUnipileAccountId(acc, newAccountId)) || null;
        return { ok: true, accountId: newAccountId, knownAccountIds: allIds, account: fallbackAccount };
    }

    return { ok: false, knownAccountIds: allIds };
}

export async function syncUnipileStatus(payload = {}) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) {
        return { ok: false, error: 'unipile-not-configured' };
    }

    const profile = payload.user || {};
    const accounts = await listUnipileAccounts();
    const linkedInAccounts = accounts.filter(isLinkedInAccount);
    const allIds = linkedInAccounts
        .map(acc => acc?.account_id || acc?.id)
        .filter(Boolean);
    console.log('[Unipile][sync] accounts snapshot', { count: linkedInAccounts.length, allIds, profile });

    const match = findMatchingLinkedInAccount(linkedInAccounts, profile);
    if (match) {
        return {
            ok: true,
            accountId: match.account_id || match.id || null,
            knownAccountIds: allIds,
            account: match || null
        };
    }

    return { ok: true, accountId: null, knownAccountIds: allIds };
}

export function combineNamePieces(...values) {
    for (const val of values) {
        if (!val) continue;
        const str = String(val).trim();
        if (str) return str;
    }
    return '';
}

export async function fetchUnipileAccountDetails(accountId) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL || !accountId) return null;

    const headers = {
        'X-API-KEY': UNIPILE_API_KEY,
        accept: 'application/json'
    };

    const mergeAccount = (base = {}, next = {}) => {
        if (!next) return base;
        const normalized = {
            ...(base || {}),
            ...(next?.data || next || {})
        };
        const mergedProfile = {
            ...(base?.profile || {}),
            ...(next?.profile || {}),
            ...(next?.data?.profile || {})
        };
        if (Object.keys(mergedProfile).length) {
            normalized.profile = mergedProfile;
        }
        return normalized;
    };

    let account = null;

    try {
        const accounts = await listUnipileAccounts();
        const match = accounts.find(acc => matchesUnipileAccountId(acc, accountId));
        if (match) {
            account = mergeAccount(account, match);
            if (account?.profile && (account.profile.public_identifier
                || account.profile.publicIdentifier
                || account.profile.linkedin_url
                || account.profile.linkedinUrl)) {
                return enrichUnipileAccount(account);
            }
        }
    } catch (err) {
        console.warn('[Unipile][accounts] Failed to hydrate account from list:', err);
    }

    const candidates = [
        () => {
            const url = new URL(`${UNIPILE_API_URL}/api/v1/accounts/${encodeURIComponent(accountId)}`);
            url.searchParams.set('with', 'profile');
            return url.toString();
        },
        () => `${UNIPILE_API_URL}/api/v1/accounts/${encodeURIComponent(accountId)}`,
        () => `${UNIPILE_API_URL}/api/v1/accounts/${encodeURIComponent(accountId)}/profile`
    ];

    for (const build of candidates) {
        let url;
        try {
            url = build();
        } catch (err) {
            console.warn('[Unipile][accounts] Unable to compose account details url:', err);
            continue;
        }

        try {
            const res = await fetch(url, { headers });
            if (!res.ok) {
                if (res.status !== 404) {
                    const text = await res.text().catch(() => '');
                    console.warn('[Unipile][accounts] Account details request failed', res.status, text || '(empty)');
                }
                continue;
            }

            const body = await res.json().catch(() => null);
            if (!body) continue;

            if (url.endsWith('/profile')) {
                account = mergeAccount(account, { profile: body });
            } else {
                account = mergeAccount(account, body);
            }

            if (account?.profile && (account.profile.public_identifier
                || account.profile.publicIdentifier
                || account.profile.linkedin_url
                || account.profile.linkedinUrl)) {
                break;
            }
        } catch (err) {
            console.warn('[Unipile][accounts] Account details fetch error:', err);
        }
    }

    if (!account) return null;

    return enrichUnipileAccount(account);
}

export async function updateUserUnipileId({ email, unipileId, userInfo = {}, accountDetails: providedAccountDetails = null } = {}) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedAccountId = String(unipileId || '').trim();

    if (!normalizedEmail) return { ok: false, error: 'missing-email' };
    if (!normalizedAccountId) return { ok: false, error: 'missing-unipile-id' };

    let existingUser = null;
    try {
        const result = await invokeSupabaseEdge('get_user_by_email', {
            email: normalizedEmail,
            columns: 'id,email,name,linkedin,unipile_id'
        }, 'users:lookup-unipile');
        if (result?.ok && result.data) {
            existingUser = result.data;
        }
    } catch (err) {
        console.warn('[Unipile][supabase] User lookup failed:', err);
    }

    let accountDetails = null;
    if (providedAccountDetails && matchesUnipileAccountId(providedAccountDetails, normalizedAccountId)) {
        accountDetails = providedAccountDetails;
    }

    try {
        const accounts = await listUnipileAccounts();
        const fetchedAccount = accounts.find(acc => matchesUnipileAccountId(acc, normalizedAccountId)) || null;
        if (fetchedAccount && accountDetails) {
            accountDetails = {
                ...fetchedAccount,
                ...accountDetails,
                profile: {
                    ...(fetchedAccount?.profile || {}),
                    ...(accountDetails?.profile || {})
                }
            };
        } else if (fetchedAccount) {
            accountDetails = fetchedAccount;
        }

        if (!accountDetails || !accountDetails.profile || (!accountDetails.profile.public_identifier
            && !accountDetails.profile.publicIdentifier
            && !accountDetails.profile.linkedin_url
            && !accountDetails.profile.linkedinUrl)) {
            const detailedAccount = await fetchUnipileAccountDetails(normalizedAccountId);
            if (detailedAccount) {
                accountDetails = {
                    ...(accountDetails || {}),
                    ...detailedAccount,
                    profile: {
                        ...(accountDetails?.profile || {}),
                        ...(detailedAccount?.profile || {})
                    }
                };
            }
        }
    } catch (err) {
        console.warn('[Unipile][accounts] Unable to list accounts during user sync:', err);
    }

    const normalizedUserLinkedIn = canonicalizeLinkedInProfileUrl(userInfo.linkedin);

    let resolvedName = combineNamePieces(
        userInfo.displayName,
        [userInfo.firstName, userInfo.lastName].filter(Boolean).join(' '),
        accountDetails?.display_name,
        accountDetails?.displayName,
        accountDetails?.name,
        accountDetails?.label,
        accountDetails?.full_name,
        accountDetails?.profile_name,
        accountDetails?.profile?.full_name,
        existingUser?.name,
        normalizedEmail
    );

    const linkedinCandidates = [
        normalizedUserLinkedIn,
        userInfo.linkedin,
        accountDetails?.profile?.linkedin_url,
        accountDetails?.profile?.linkedinUrl,
        accountDetails?.profile_url,
        accountDetails?.profileUrl,
        accountDetails?.profile_link,
        accountDetails?.profileLink,
        accountDetails?.public_profile_url,
        accountDetails?.publicProfileUrl,
        accountDetails?.url,
        accountDetails?.profile?.url,
        accountDetails?.profile?.profile_url,
        accountDetails?.profile?.profileUrl,
        accountDetails?.profile?.public_identifier,
        accountDetails?.profile?.publicIdentifier,
        accountDetails?.public_identifier,
        accountDetails?.publicIdentifier,
        accountDetails?.username,
        accountDetails?.login?.username,
        accountDetails?.handle,
        existingUser?.linkedin
    ];

    let linkedinUrl = null;
    for (const candidate of linkedinCandidates) {
        const normalized = canonicalizeLinkedInProfileUrl(candidate);
        if (normalized) {
            linkedinUrl = normalized;
            break;
        }
    }

    if (!linkedinUrl && accountDetails) {
        const identifierSource = [
            accountDetails?.profile?.public_identifier,
            accountDetails?.profile?.publicIdentifier,
            accountDetails?.public_identifier,
            accountDetails?.publicIdentifier,
            accountDetails?.username,
            accountDetails?.login?.username
        ];
        let identifier = null;
        for (const candidate of identifierSource) {
            const slug = extractLinkedInIdentifier(candidate);
            if (slug) {
                identifier = slug;
                break;
            }
        }

        if (identifier) {
            try {
                const profile = await fetchUnipileLinkedInProfile(normalizedAccountId, identifier);
                if (profile) {
                    const profileLinkedIn = canonicalizeLinkedInProfileUrl(
                        profile.profile_url
                        || profile.profileUrl
                        || profile.public_identifier
                        || profile.publicIdentifier
                        || profile.url
                        || identifier
                    );
                    if (profileLinkedIn) {
                        linkedinUrl = profileLinkedIn;
                    }
                    const profileName = combineNamePieces(
                        profile.full_name,
                        [profile.first_name, profile.last_name].filter(Boolean).join(' ')
                    );
                    if (profileName && (!resolvedName || resolvedName === normalizedEmail)) {
                        resolvedName = profileName;
                    }
                }
            } catch (err) {
                console.warn('[Unipile][supabase] Failed to fetch LinkedIn profile for account:', err);
            }
        }
    }

    const finalLinkedIn = linkedinUrl || normalizedUserLinkedIn || existingUser?.linkedin || null;
    if (!finalLinkedIn) {
        console.warn('[Unipile][supabase] Missing LinkedIn URL while syncing user.', { email: normalizedEmail });
        return { ok: false, error: 'missing-linkedin-profile' };
    }

    const upsertRecord = {
        email: normalizedEmail,
        name: resolvedName || normalizedEmail,
        unipile_id: normalizedAccountId
    };

    upsertRecord.linkedin = finalLinkedIn;

    try {
        console.log('[Unipile][supabase] Upserting user record', { email: normalizedEmail, unipileId: normalizedAccountId });
        const result = await invokeSupabaseEdge('upsert_user_unipile', { record: upsertRecord }, 'users:upsert-unipile');

        if (!result?.ok) {
            console.warn('[Unipile][supabase] Upsert failed', result?.httpStatus, result?.error, result?.details || null);
            return { ok: false, error: result?.error || `supabase-${result?.httpStatus}`, details: result?.details || null };
        }

        const body = Array.isArray(result?.data) ? result.data : [result?.data].filter(Boolean);
        console.log('[Unipile][supabase] Upsert ok');
        return { ok: true, data: body };
    } catch (err) {
        console.warn('[Specter-Outreach] Supabase user upsert failed:', err);
        return { ok: false, error: err.message };
    }
}

export async function sendLinkedInChat(accountId, providerId, message) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) {
        throw new Error('unipile_not_configured');
    }
    if (!accountId || !providerId) {
        throw new Error('missing_linkedin_context');
    }

    const form = new FormData();
    form.set('account_id', accountId);
    if (message) form.set('text', message);
    form.append('attendees_ids', providerId);
    form.set('linkedin[api]', 'classic');

    const res = await fetch(`${UNIPILE_API_URL}/api/v1/chats`, {
        method: 'POST',
        headers: {
            'X-API-KEY': UNIPILE_API_KEY,
            accept: 'application/json'
        },
        body: form
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `LinkedIn chat error ${res.status}`);
    }

    return await res.json().catch(() => ({}));
}

export async function sendLinkedInInvite(accountId, providerId, message) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) {
        throw new Error('unipile_not_configured');
    }
    if (!accountId || !providerId) {
        throw new Error('missing_linkedin_context');
    }

    const payload = {
        account_id: accountId,
        provider_id: providerId
    };

    if (message) {
        payload.message = message;
    }

    const res = await fetch(`${UNIPILE_API_URL}/api/v1/users/invite`, {
        method: 'POST',
        headers: {
            'X-API-KEY': UNIPILE_API_KEY,
            accept: 'application/json',
            'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `LinkedIn invite error ${res.status}`);
    }

    return await res.json().catch(() => ({}));
}

export async function sendLinkedInMessageToChat({ chatId, message, accountId }) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) {
        throw new Error('unipile_not_configured');
    }
    if (!chatId) {
        throw new Error('missing_chat');
    }

    const form = new FormData();
    if (accountId) {
        form.set('account_id', accountId);
    }
    if (message) {
        form.set('text', message);
    }

    const res = await fetch(`${UNIPILE_API_URL}/api/v1/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: {
            'X-API-KEY': UNIPILE_API_KEY,
            accept: 'application/json'
        },
        body: form
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `LinkedIn message error ${res.status}`);
    }

    return await res.json().catch(() => ({}));
}

export function parseLinkedInTimestamp(message) {
    if (!message || typeof message !== 'object') return null;
    const candidates = [
        message.sent_at,
        message.created_at,
        message.updated_at,
        message.delivered_at,
        message.timestamp,
        message.date,
        message.sentAt,
        message.createdAt,
        message.ts
    ];

    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        if (typeof candidate === 'number') {
            if (!Number.isFinite(candidate)) continue;
            const ms = candidate > 1e12 ? candidate : candidate * 1000;
            const date = new Date(ms);
            if (!isNaN(date.getTime())) return date;
        } else if (typeof candidate === 'string') {
            const trimmed = candidate.trim();
            if (!trimmed) continue;
            if (/^\d+$/.test(trimmed)) {
                const numeric = Number(trimmed);
                if (!Number.isFinite(numeric)) continue;
                const ms = numeric > 1e12 ? numeric : numeric * 1000;
                const date = new Date(ms);
                if (!isNaN(date.getTime())) return date;
                continue;
            }
            const date = new Date(trimmed);
            if (!isNaN(date.getTime())) return date;
        } else {
            const date = new Date(candidate);
            if (!isNaN(date.getTime())) return date;
        }
    }

    return null;
}

export function extractLinkedInMessageText(message) {
    if (message === null || message === undefined) return null;
    if (typeof message === 'string') {
        const trimmed = message.trim();
        return trimmed || null;
    }

    if (typeof message !== 'object') {
        return null;
    }

    const visited = new WeakSet();
    const stack = [message];
    const textKeys = ['text', 'body', 'body_text', 'bodyText', 'content', 'message', 'preview', 'snippet', 'caption', 'comment'];

    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);

        for (const key of textKeys) {
            if (!(key in current)) continue;
            const value = current[key];
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) return trimmed;
            } else if (value && typeof value === 'object') {
                stack.push(value);
            }
        }

        if (Array.isArray(current.bodySegments)) {
            for (const segment of current.bodySegments) {
                if (typeof segment === 'string') {
                    const trimmed = segment.trim();
                    if (trimmed) return trimmed;
                } else if (segment && typeof segment === 'object') {
                    stack.push(segment);
                }
            }
        }
    }

    return null;
}

export function isLinkedInMessageFromContact(msg, targetProvider) {
    if (!msg) return false;

    if (msg.is_sender === false || msg.isSender === false) return true;
    if (msg.is_sender === true || msg.isSender === true) return false;

    const senderCandidates = [
        msg.sender_id,
        msg.senderId,
        msg?.sender?.provider_id,
        msg?.sender?.providerId,
        msg?.sender?.id,
        msg?.sender?.identifier,
        msg?.sender?.linkedin_id,
        msg?.sender?.linkedinId,
        msg?.author?.provider_id,
        msg?.author?.id
    ].filter(Boolean).map(val => String(val).toLowerCase());

    if (senderCandidates.length && targetProvider) {
        return senderCandidates.includes(targetProvider);
    }

    if (senderCandidates.length) {
        return true;
    }

    return true;
}

export async function detectLinkedInReply(task, since, options = {}) {
    const linkedInContext = options?.linkedInContext || null;
    const debugBase = {
        taskId: task?.id ?? null,
        hasTask: Boolean(task),
        hasUnipileConfig: Boolean(UNIPILE_API_KEY && UNIPILE_API_URL)
    };

    if (!task || !UNIPILE_API_KEY || !UNIPILE_API_URL) {
        console.log('[Specter-Outreach][Debug] Skipping LinkedIn reply lookup – missing task or Unipile config', debugBase);
        return false;
    }

    const linkedinCandidates = [
        task.linkedinProfile,
        task.contactLinkedIn,
        task.linkedin,
        task.linkedinUrl,
        task?.company?.linkedin
    ];

    const linkedinUrl = linkedinCandidates.find(Boolean);
    if (!linkedinUrl) {
        console.log('[Specter-Outreach][Debug] Skipping LinkedIn reply lookup – no LinkedIn URL on task', { ...debugBase, linkedinCandidates });
        return false;
    }

    const identifier = extractLinkedInIdentifier(linkedinUrl);
    if (!identifier) {
        console.log('[Specter-Outreach][Debug] Skipping LinkedIn reply lookup – unable to derive LinkedIn identifier', { ...debugBase, linkedinUrl });
        return false;
    }

    const accountId = linkedInContext?.accountId ?? null;
    if (!accountId) {
        console.log('[Specter-Outreach][Debug] Skipping LinkedIn reply lookup – missing linked Unipile account', { ...debugBase, identifier, linkedinUrl });
        return false;
    }

    let providerId = [
        task.providerId,
        task.provider_id,
        task.linkedinProviderId,
        task.linkedin_provider_id
    ].find(value => value != null && String(value).trim());

    let profile = null;

    if (!providerId) {
        const cacheKey = identifier.toLowerCase();
        if (linkedInContext?.profileCache?.has(cacheKey)) {
            profile = linkedInContext.profileCache.get(cacheKey);
        } else {
            try {
                profile = await fetchUnipileLinkedInProfile(accountId, identifier);
            } catch (err) {
                console.warn('[Specter-Outreach][Debug] LinkedIn profile fetch failed during reply lookup', err);
                profile = null;
            }
            if (linkedInContext?.profileCache) {
                linkedInContext.profileCache.set(cacheKey, profile);
            }
        }

        providerId = [
            profile?.provider_id,
            profile?.id,
            profile?.providerId,
            profile?.public_identifier,
            profile?.publicIdentifier
        ].find(value => value != null && String(value).trim());
    }

    if (!providerId) {
        console.log('[Specter-Outreach][Debug] Skipping LinkedIn reply lookup – missing LinkedIn provider id', {
            ...debugBase,
            identifier,
            linkedinUrl,
            accountId,
            profile: profile ? {
                id: profile.id ?? null,
                provider_id: profile.provider_id ?? null,
                public_identifier: profile.public_identifier ?? null
            } : null
        });
        return false;
    }

    const normalizedProviderId = String(providerId).trim();
    console.log('[Specter-Outreach][Debug] Resolving LinkedIn chat for reply lookup', {
        ...debugBase,
        identifier,
        linkedinUrl,
        accountId,
        providerId: normalizedProviderId,
        hasStoredChatId: Boolean(task.chatId)
    });

    let chatId = task.chatId || null;
    const providerCache = linkedInContext?.chatIdCache || null;
    const providerCacheKey = normalizedProviderId.toLowerCase();

    if (!chatId && providerCache && providerCache.has(providerCacheKey)) {
        const cached = providerCache.get(providerCacheKey);
        chatId = cached || null;
    }

    if (!chatId) {
        chatId = await findLinkedInChatId(accountId, normalizedProviderId, {
            preloadedChats: linkedInContext?.chatRecord,
            logContext: { providerId: normalizedProviderId }
        });
        if (providerCache) {
            providerCache.set(providerCacheKey, chatId || false);
        }
    }

    if (chatId) {
        console.log('[Specter-Outreach][Debug] LinkedIn chat resolved for reply lookup', {
            ...debugBase,
            providerId: normalizedProviderId,
            chatId
        });
    }
    if (!chatId) {
        console.log('[Specter-Outreach][Debug] Skipping LinkedIn reply lookup – unable to resolve chat id', {
            ...debugBase,
            identifier,
            linkedinUrl,
            accountId,
            providerId: normalizedProviderId
        });
        return false;
    }

    const messages = await fetchLinkedInChatMessages(accountId, chatId, { limit: 75 });
    if (!messages.length) {
        console.log('[Specter-Outreach][Debug] No LinkedIn messages returned for chat', {
            ...debugBase,
            accountId,
            providerId: normalizedProviderId,
            chatId
        });
        return false;
    }

    let sinceDate = null;
    if (since instanceof Date) {
        sinceDate = Number.isNaN(since.valueOf()) ? null : since;
    } else if (since) {
        const parsed = new Date(since);
        sinceDate = Number.isNaN(parsed.valueOf()) ? null : parsed;
    }
    const sinceMs = sinceDate ? sinceDate.getTime() : null;
    const targetProvider = normalizedProviderId ? normalizedProviderId.toLowerCase() : null;

    let latestFounderMessage = null;
    let hasRecentReply = false;

    for (const msg of messages) {
        const ts = parseLinkedInTimestamp(msg);
        if (!ts) continue;
        if (!isLinkedInMessageFromContact(msg, targetProvider)) continue;

        if (!latestFounderMessage || ts.getTime() > latestFounderMessage.timestamp.getTime()) {
            latestFounderMessage = { message: msg, timestamp: ts };
        }

        if (!hasRecentReply && (sinceMs === null || ts.getTime() > sinceMs)) {
            hasRecentReply = true;
        }
    }

    if (latestFounderMessage) {
        const { message, timestamp } = latestFounderMessage;
        const text = extractLinkedInMessageText(message);
        console.log('[Specter-Outreach][Debug] Latest founder LinkedIn reply before cutoff', {
            providerId: targetProvider || null,
            timestamp: timestamp.toISOString(),
            rawTimestamps: {
                sent_at: message.sent_at ?? null,
                created_at: message.created_at ?? null,
                updated_at: message.updated_at ?? null,
                delivered_at: message.delivered_at ?? null,
                timestamp: message.timestamp ?? null
            },
            text: text ? text.slice(0, 500) : null
        });
    } else {
        console.log('[Specter-Outreach][Debug] No founder LinkedIn replies found before cutoff', {
            providerId: targetProvider || null
        });
    }

    return hasRecentReply;
}

export async function runLinkedInTask({ task, accountId }) {
    const linkedinCandidates = [
        task.contactLinkedIn,
        task.linkedinProfile,
        task.linkedin,
        task.linkedinUrl
    ];

    const linkedinUrl = linkedinCandidates.find(Boolean);
    if (!linkedinUrl) {
        throw new Error('missing_linkedin_profile');
    }

    const identifier = extractLinkedInIdentifier(linkedinUrl);
    if (!identifier) {
        throw new Error('invalid_linkedin_identifier');
    }

    const profile = await fetchUnipileLinkedInProfile(accountId, identifier);
    if (!profile) {
        throw new Error('linkedin_profile_not_found');
    }

    const providerId = String(profile.provider_id || profile.id || profile.public_identifier || identifier).trim();
    if (!providerId) {
        throw new Error('missing_linkedin_provider');
    }

    const isConnected = profile.is_relationship === true
        || String(profile.network_distance || '').toUpperCase() === 'FIRST_DEGREE';

    const message = task.message || '';

    const knownChatId = task.chatId
        || task.chatProviderId
        || task.linkedinChatId
        || null;

    let chatId = knownChatId;
    if (!chatId) {
        chatId = await findLinkedInChatId(accountId, providerId);
    }

    if (chatId) {
        await sendLinkedInMessageToChat({ chatId, message, accountId });
        return { mode: 'message_existing_chat', providerId, chatId };
    }

    if (isConnected) {
        const response = await sendLinkedInChat(accountId, providerId, message);
        const createdChatId = response?.chat_id || response?.id || response?.uuid || null;
        return { mode: 'message_new_chat', providerId, chatId: createdChatId };
    }

    await sendLinkedInInvite(accountId, providerId, message);
    return { mode: 'invite', providerId };
}
