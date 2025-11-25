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
