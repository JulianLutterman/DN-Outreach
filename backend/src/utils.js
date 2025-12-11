// backend/src/utils.js

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeEmail(value) {
    if (!value) return '';
    return String(value).trim().toLowerCase();
}

export function normalizeTaskContext(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return {};
        try {
            return normalizeTaskContext(JSON.parse(trimmed));
        } catch (err) {
            console.warn('[Specter-Outreach] Failed to parse task context JSON:', err);
            return {};
        }
    }
    if (typeof raw !== 'object') {
        return {};
    }
    try {
        return JSON.parse(JSON.stringify(raw));
    } catch (err) {
        console.warn('[Specter-Outreach] Failed to clone task context:', err);
        const clone = {};
        for (const [key, value] of Object.entries(raw)) {
            clone[key] = value;
        }
        return clone;
    }
}

export function escapeRegExp(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyTemplateReplacements(text, replacements = {}) {
    let result = typeof text === 'string' ? text : '';
    for (const [token, value] of Object.entries(replacements)) {
        if (value === undefined || value === null) continue;
        if (typeof token !== 'string' || !token) continue;
        if (!result.includes(token)) continue;
        const regex = new RegExp(escapeRegExp(token), 'g');
        result = result.replace(regex, value);
    }
    return result;
}

export function extractFirstName(fullName) {
    if (!fullName) return '';
    const parts = String(fullName).trim().split(/\s+/);
    return parts.length ? parts[0] : '';
}

export function odataQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

export function normalizeSubjectBase(subj = '') {
    // Strips Re:, Fwd:, Fw:, Aw:, Antwort:, Wg:, Betreff:, Tr: (case insensitive)
    return String(subj).replace(/^((re|fwd|fw|aw|antwort|wg|betreff|tr)(\s*:\s*|\s+))+/i, '').trim();
}

export async function fetchJSON(url, token, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: {
            ...(init.headers || {}),
            'Authorization': `Bearer ${token}`,
        }
    });

    if (!res.ok) {
        let txt = '';
        try { txt = await res.text(); } catch { }
        throw new Error(txt || `HTTP ${res.status}`);
    }

    const statusNoBody = res.status === 202 || res.status === 204;
    const contentLen = res.headers.get('content-length');
    const contentType = res.headers.get('content-type') || '';

    if (statusNoBody || contentLen === '0' || !contentType) return {};

    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
}

export function buildHtmlBody(plainText, signatureHtml, shouldAppend) {
    let html = String(plainText || '').replace(/\n/g, '<br/>');
    if (shouldAppend && signatureHtml && signatureHtml.trim()) {
        const sep = html.endsWith('<br/>') ? '' : '<br/><br/>';
        html = html + sep + signatureHtml.trim();
    }
    return html;
}

// Alias for backward compatibility
export const buildHtmlBodyForBg = buildHtmlBody;

// URL and domain utilities
export function ensureHttpUrl(value = '') {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
}

export function extractDomainFromUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
        return url.hostname.replace(/^www\./, '').toLowerCase();
    } catch (err) {
        return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    }
}

// LinkedIn utilities
export function extractLinkedInIdentifier(value) {
    if (!value) return null;
    let raw = String(value).trim();
    if (!raw) return null;

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
    return 'https://www.linkedin.com/in/' + identifier;
}

export function deriveLinkedInFromAccount(account = {}) {
    if (!account) return null;

    const directCandidates = [
        account?.linkedin,
        account?.profile?.linkedin_url,
        account?.profile?.linkedinUrl,
        account?.profile_url,
        account?.profileUrl,
        account?.profile_link,
        account?.profileLink,
        account?.public_profile_url,
        account?.publicProfileUrl,
        account?.url,
        account?.profile?.url,
        account?.profile?.profile_url,
        account?.profile?.profileUrl
    ];

    for (const candidate of directCandidates) {
        const normalized = canonicalizeLinkedInProfileUrl(candidate);
        if (normalized) {
            return normalized;
        }
    }

    const identifierSource = [
        account?.profile?.public_identifier,
        account?.profile?.publicIdentifier,
        account?.public_identifier,
        account?.publicIdentifier,
        account?.username,
        account?.login?.username,
        account?.handle
    ];

    for (const candidate of identifierSource) {
        const slug = extractLinkedInIdentifier(candidate);
        if (slug) {
            return 'https://www.linkedin.com/in/' + slug;
        }
    }

    return null;
}

// Name parsing utilities
export function splitFullName(fullName = '') {
    const clean = String(fullName || '').trim();
    if (!clean) return { firstName: '', lastName: '', parts: [] };
    const parts = clean.split(/\s+/).filter(Boolean);
    if (!parts.length) return { firstName: '', lastName: '', parts: [] };
    const firstName = parts[0];
    const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
    return { firstName, lastName, parts };
}

// Email utilities
export function parseEmailList(value = '') {
    return String(value || '')
        .split(/[;,]/)
        .map(x => x.trim())
        .filter(Boolean);
}

export function dedupeEmails(emails = []) {
    const seen = new Set();
    const result = [];
    for (const email of emails) {
        const key = normalizeEmail(email);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(email);
    }
    return result;
}
