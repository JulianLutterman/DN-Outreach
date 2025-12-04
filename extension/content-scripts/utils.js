// content-scripts/utils.js

// Only Chrome-specific utilities remain here
// All other utilities have been moved to backend

export async function sendMessageWithTimeout(type, payload, timeoutMs = 4000) {
    return await Promise.race([
        new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve)),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs))
    ]);
}

// Re-export commonly used utilities that are now fetched from backend config
// These are thin wrappers that will need to be replaced with backend API calls
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function escapeRegExp(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

// Email utilities needed by workflow.js
export function normalizeEmail(value) {
    if (!value) return '';
    return String(value).trim().toLowerCase();
}

export function parseEmailList(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return [];
    return raw
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(Boolean);
}

export function dedupeEmails(emails = []) {
    const seen = new Map();
    const result = [];
    for (const email of emails) {
        const key = normalizeEmail(email);
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.set(key, true);
        result.push(email);
    }
    return result;
}

export function buildHtmlBody(plainText, signatureHtml, shouldAppend) {
    let html = String(plainText || '').replace(/\n/g, '<br/>');
    if (shouldAppend && signatureHtml && signatureHtml.trim()) {
        const sep = html.endsWith('<br/>') ? '' : '<br/><br/>';
        html = html + sep + signatureHtml.trim();
    }
    return html;
}

export function normalizeSubjectBase(subj = '') {
    return String(subj).replace(/^(re|fwd|fw):\s*/i, '').trim();
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
