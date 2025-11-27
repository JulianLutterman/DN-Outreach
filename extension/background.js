/* global chrome */

import { getAccessToken, resolveActiveOutlookSession } from './microsoft.js';

const BACKEND_URL = 'https://dnoutreach.vercel.app';

console.log('[Specter-Outreach] Background worker initialised (Thin Client)');

async function getUnipileAccountId() {
    try {
        const { unipileAccountId } = await chrome.storage.sync.get('unipileAccountId');
        if (unipileAccountId) return unipileAccountId;
    } catch (e) { }
    try {
        const { unipileAccountId } = await chrome.storage.local.get('unipileAccountId');
        if (unipileAccountId) return unipileAccountId;
    } catch (e) { }
    return null;
}

async function callBackend(endpoint, payload = {}) {
    try {
        const unipileAccountId = await getUnipileAccountId();
        const finalPayload = { ...payload, unipileAccountId };

        const res = await fetch(`${BACKEND_URL}/api/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(finalPayload)
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(txt || `HTTP ${res.status}`);
        }
        return await res.json();
    } catch (err) {
        console.error(`[Specter-Outreach] Backend call failed (${endpoint}):`, err);
        return { ok: false, error: err.message };
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            // --- Local Handlers ---

            if (msg.type === 'GET_MS_TOKEN') {
                const token = await getAccessToken({ interactive: true });
                sendResponse({ ok: true, token });
                return;
            }

            // --- Backend Handlers ---

            if (msg.type === 'GET_NOTION_CONTENT') {
                const res = await callBackend('notion/content', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'FETCH_PARTNERS') {
                const res = await callBackend('partners', {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'FETCH_WORKFLOW_SNAPSHOT') {
                const res = await callBackend('workflow/snapshot', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'DELETE_SUPABASE_TASK') {
                const res = await callBackend('tasks/delete', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'PROCESS_OVERDUE_TASKS') {
                // We need to pass the MS token for email sending
                let msToken = null;
                try {
                    msToken = await getAccessToken({ interactive: false });
                } catch (e) {
                    console.warn('[Specter-Outreach] Failed to get silent token for overdue tasks:', e);
                }

                const payload = { ...(msg.payload || {}), msToken };
                const res = await callBackend('tasks/overdue', payload);
                sendResponse(res);
                return;
            }

            if (msg.type === 'ENRICH_FOUNDER') {
                const res = await callBackend('hunter/enrich', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'UPSERT_COMPANY') {
                const res = await callBackend('company/upsert', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'UPSERT_TASKS') {
                const res = await callBackend('tasks/upsert', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'GENERATE_UNIPILE_LINKEDIN_LOGIN') {
                const res = await callBackend('unipile/generate-login', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'START_PARALLEL_FOUNDER_TASK') {
                const res = await callBackend('parallel/start', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'GET_PARALLEL_FOUNDER_RESULT') {
                const res = await callBackend('parallel/result', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'CHECK_UNIPILE_LINKEDIN_ACCOUNT') {
                const res = await callBackend('unipile/check-account', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'SYNC_UNIPILE_STATUS') {
                const res = await callBackend('unipile/sync-status', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'UPSERT_USER_UNIPILE_ID') {
                const res = await callBackend('unipile/upsert-user', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'GET_AFFINITY_DEAL_STATUS') {
                const res = await callBackend('affinity/status', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'ADD_TO_DEAL_PIPELINE') {
                const res = await callBackend('affinity/add', msg.payload || {});
                sendResponse(res);
                return;
            }

            if (msg.type === 'LANGFUSE_LOG_LLM') {
                const res = await callBackend('langfuse/log', msg.payload || {});
                sendResponse(res);
                return;
            }

        } catch (err) {
            console.error('[Specter-Outreach] Background script error:', err);
            sendResponse({ ok: false, error: err.message });
        }
    })();
    return true;
});

chrome.action.onClicked.addListener(async tab => {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['contentScript.js']
        });
        console.log('[Specter-Outreach] contentScript.js executed via scripting API');
    } catch (e) {
        console.error('[Specter-Outreach] Injection error:', e);
    }
});
