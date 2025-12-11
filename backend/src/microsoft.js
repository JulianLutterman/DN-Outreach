// background-scripts/microsoft.js

import { normalizeEmail, fetchJSON, odataQuote, normalizeSubjectBase } from './utils.js';

export async function logLatestEmailReplyDebug(contactEmail, token) {
    if (!token || !contactEmail) return;

    try {
        const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
        url.searchParams.set('$filter', `from/emailAddress/address eq ${odataQuote(contactEmail.toLowerCase())}`);
        url.searchParams.set('$top', '25');
        url.searchParams.set('$select', 'id,receivedDateTime,subject,bodyPreview');

        const list = await fetchJSON(url.toString(), token);
        const values = Array.isArray(list?.value) ? list.value : [];
        let latest = null;
        for (const item of values) {
            const received = item?.receivedDateTime ? new Date(item.receivedDateTime) : null;
            if (!received || Number.isNaN(received.valueOf())) continue;
            if (!latest || received.getTime() > latest.received.getTime()) {
                latest = { item, received };
            }
        }
        if (latest) {
            const { item, received } = latest;
            console.log('[Specter-Outreach][Debug] Latest founder email reply before cutoff', {
                contactEmail,
                receivedDateTime: item.receivedDateTime || null,
                receivedIso: received && !Number.isNaN(received.valueOf()) ? received.toISOString() : null,
                subject: item.subject || null,
                bodyPreview: item.bodyPreview || null
            });
        } else {
            console.log('[Specter-Outreach][Debug] No founder email replies found before cutoff', {
                contactEmail
            });
        }
    } catch (err) {
        console.warn('[Specter-Outreach][Debug] Failed to fetch latest founder email reply for logging', err);
    }
}

export async function hasRecentEmailResponse(contactEmail, token, sinceIso) {
    if (!token || !contactEmail) return false;

    await logLatestEmailReplyDebug(contactEmail, token);

    try {
        const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
        const filters = [`from/emailAddress/address eq ${odataQuote(contactEmail.toLowerCase())}`];
        if (sinceIso) {
            const sinceDate = new Date(sinceIso);
            if (!Number.isNaN(sinceDate.valueOf())) {
                filters.push(`receivedDateTime ge ${sinceDate.toISOString()}`);
            }
        }
        url.searchParams.set('$filter', filters.join(' and '));
        url.searchParams.set('$top', '1');
        url.searchParams.set('$select', 'id');

        const list = await fetchJSON(url.toString(), token);
        const values = Array.isArray(list?.value) ? list.value : [];
        return values.length > 0;
    } catch (err) {
        console.warn('[Specter-Outreach] Email reply lookup failed:', err);
        return false;
    }
}

export async function hasConversationResponse(conversationId, token, sinceIso, myAddress) {
    if (!token || !conversationId) return false;

    try {
        const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
        url.searchParams.set('$filter', `conversationId eq ${odataQuote(conversationId)}`);
        url.searchParams.set('$orderby', 'receivedDateTime desc');
        url.searchParams.set('$top', '10');
        url.searchParams.set('$select', 'id,from,receivedDateTime');

        const list = await fetchJSON(url.toString(), token);
        const values = Array.isArray(list?.value) ? list.value : [];
        const sinceDate = sinceIso ? new Date(sinceIso) : null;

        return values.some(m => {
            const fromAddr = (m.from?.emailAddress?.address || '').toLowerCase();
            const received = new Date(m.receivedDateTime || 0);

            // Check if it's a new message
            const isNew = !sinceDate || (received > sinceDate);
            // Check if it's NOT from me (i.e. it's a reply)
            const isNotMe = myAddress ? (fromAddr !== myAddress.toLowerCase()) : true;

            return isNew && isNotMe;
        });
    } catch (err) {
        console.warn('[Specter-Outreach] Conversation reply lookup failed:', err);
        return false;
    }
}

export async function listConversationMessages(conversationId, token) {
    const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
    url.searchParams.set('$filter', `conversationId eq ${odataQuote(conversationId)}`);
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$top', '50');
    url.searchParams.set('$select', 'id,from,receivedDateTime,conversationId,sentDateTime,subject');
    const list = await fetchJSON(url.toString(), token);
    return list.value || [];
}

export async function resolveAnchorMessage(task, token, myAddress) {
    if (task.anchorId) {
        try {
            const msg = await fetchJSON(
                `https://graph.microsoft.com/v1.0/me/messages/${task.anchorId}?$select=id,conversationId,sentDateTime,subject,from`,
                token
            );
            if (msg?.id) {
                console.log('[Specter-Outreach] Anchor via stored anchorId');
                return msg;
            }
        } catch (_) {
            console.warn('[Specter-Outreach] Stored anchorId not resolvable; falling back.');
        }
    }

    try {
        const msg = await fetchJSON(
            `https://graph.microsoft.com/v1.0/me/messages/${task.messageId}?$select=id,conversationId,sentDateTime,subject,from`,
            token
        );
        if (msg?.id) {
            console.log('[Specter-Outreach] Anchor via original messageId');
            return msg;
        }
    } catch (_) { }

    const convId = task.anchorConversationId || task.conversationId;
    if (convId) {
        try {
            const list = await listConversationMessages(convId, token);
            if (list.length) {
                console.log('[Specter-Outreach] Anchor via conversation list', { count: list.length });
                return list[0];
            }
        } catch (_) { }
    }

    if (convId) {
        const urlSent = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages');
        urlSent.searchParams.set('$filter',
            `conversationId eq '${String(convId).replace(/'/g, "''")}' and from/emailAddress/address eq '${String(myAddress).replace(/'/g, "''")}'`
        );
        urlSent.searchParams.set('$orderby', 'sentDateTime desc');
        urlSent.searchParams.set('$top', '100');
        urlSent.searchParams.set('$select', 'id,conversationId,sentDateTime,subject,from');
        try {
            const list = await fetchJSON(urlSent.toString(), token);
            if (list.value?.length) {
                console.log('[Specter-Outreach] Anchor via Sent Items + conversation');
                return list.value[0];
            }
        } catch (_) { }
    }

    const recipients = Array.isArray(task.toList) ? task.toList : [];
    const anyTo = recipients
        .map(addr => `a/emailAddress/address eq '${String(addr).toLowerCase().replace(/'/g, "''")}'`)
        .join(' or ');
    const anyToExpr = anyTo ? `(toRecipients/any(a: ${anyTo}))` : null;

    const subjBase = normalizeSubjectBase(task.subject || '');
    const floor = new Date((new Date(task.anchorSentAt || task.originalSentAt || task.scheduledAt || Date.now())).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const parts = [
        `from/emailAddress/address eq '${String(myAddress).replace(/'/g, "''")}'`,
        subjBase ? `startswith(subject, '${subjBase.replace(/'/g, "''")}')` : null,
        anyToExpr,
        `sentDateTime ge ${floor}`
    ].filter(Boolean);

    const urlSent2 = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages');
    urlSent2.searchParams.set('$filter', parts.join(' and '));
    urlSent2.searchParams.set('$orderby', 'sentDateTime desc');
    urlSent2.searchParams.set('$top', '100');
    urlSent2.searchParams.set('$select', 'id,conversationId,sentDateTime,subject,from');

    try {
        const list2 = await fetchJSON(urlSent2.toString(), token);
        if (list2.value?.length) {
            console.log('[Specter-Outreach] Anchor via Sent Items heuristic');
            return list2.value[0];
        }
    } catch (_) { }

    const base = subjBase.replace(/"/g, '\\"');
    const searchHeaders = { 'ConsistencyLevel': 'eventual' };
    const tryQueries = [];

    const addQuery = (q) => tryQueries.push(q);
    for (const addr of recipients) {
        addQuery(`from:me subject:"${base}" to:${addr}`);
    }
    if (!tryQueries.length) addQuery(`from:me subject:"${base}"`);

    for (const q of tryQueries) {
        const urlSearch = new URL('https://graph.microsoft.com/v1.0/me/messages');
        urlSearch.searchParams.set('$search', q);
        urlSearch.searchParams.set('$top', '25');
        urlSearch.searchParams.set('$select', 'id,conversationId,sentDateTime,subject,from,toRecipients,ccRecipients');

        try {
            const list3 = await fetchJSON(urlSearch.toString(), token, { headers: searchHeaders });
            const items = Array.isArray(list3.value) ? list3.value : [];
            const want = new Set(recipients.map(r => String(r).toLowerCase()));
            const candidate = items.find(m => {
                const fromMe = (m.from?.emailAddress?.address || '').toLowerCase() === myAddress.toLowerCase();
                const mBase = normalizeSubjectBase(m.subject || '');
                const subjOk = mBase && mBase.startsWith(base);
                const recips = [
                    ...((m.toRecipients || []).map(r => r.emailAddress?.address) || []),
                    ...((m.ccRecipients || []).map(r => r.emailAddress?.address) || [])
                ].map(e => String(e).toLowerCase());
                const hasAny = recips.some(r => want.has(r)) || want.size === 0;
                return fromMe && subjOk && hasAny;
            });
            if (candidate) {
                console.log('[Specter-Outreach] Anchor via global $search');
                return candidate;
            }
        } catch (_) { }
    }

    return null;
}
