// background-scripts/tasks.js

import { UNIPILE_API_KEY, UNIPILE_API_URL } from './config.js';
import { normalizeEmail, normalizeTaskContext, extractFirstName, buildHtmlBodyForBg, applyTemplateReplacements, fetchJSON, odataQuote, normalizeSubjectBase } from './utils.js';
import { ensureSupabaseUser, fetchOverdueTasks, fetchUpcomingTasksForUser, deleteSupabaseTask } from './supabase.js';
import { resolveAnchorMessage, hasRecentEmailResponse } from './microsoft.js';
import { getLinkedInChats, detectLinkedInReply, runLinkedInTask } from './unipile.js';

export function resolveTaskLinkedInCandidate(task, context = {}) {
    const company = task?.company || {};
    const candidates = [
        context.contactLinkedIn,
        context.linkedinProfile,
        company.linkedin,
        task?.contactLinkedIn,
        task?.linkedin,
        task?.linkedinUrl
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        const value = String(candidate).trim();
        if (value) return value;
    }

    return null;
}

export async function hasFounderRespondedForTask(task, { token = null, sinceIso = null, linkedInContext = null, forceDeepCheck = false, myAddress = null } = {}) {
    if (!task) return false;

    const createdAtRaw = task.created_at || task.createdAt || null;
    const createdAtDate = createdAtRaw ? new Date(createdAtRaw) : null;
    console.log('[Specter-Outreach][Debug] Task creation timestamp', {
        taskId: task.id || null,
        created_at: createdAtRaw,
        createdIso: createdAtDate && !Number.isNaN(createdAtDate.valueOf()) ? createdAtDate.toISOString() : null,
        forceDeepCheck: !!forceDeepCheck
    });

    const context = normalizeTaskContext(task.context);
    const company = task.company || {};
    const contactEmail = String(context.contactEmail || company.email || '').trim().toLowerCase();
    const contactLinkedIn = resolveTaskLinkedInCandidate(task, context);

    const sinceDate = sinceIso ? new Date(sinceIso) : null;
    const normalizedSinceDate = sinceDate && !Number.isNaN(sinceDate.valueOf()) ? sinceDate : null;

    console.log('[Specter-Outreach][Debug] hasFounderRespondedForTask', {
        taskId: task.id,
        contactEmail,
        forceDeepCheck,
        hasToken: !!token,
        myAddress,
        sinceIso
    });

    const emailPromise = contactEmail
        ? (async () => {
            // Fallback / Standard check
            const standardEmailCheck = await hasRecentEmailResponse(contactEmail, token, sinceIso);
            if (standardEmailCheck) return true;

            // Deep check (Conversation + Subject) as fallback
            if (token && myAddress) {
                try {
                    const checkTask = {
                        ...task,
                        toList: task.toList || (contactEmail ? [contactEmail] : []),
                        subject: task.subject || context.subject || ''
                    };
                    return await detectReply(
                        checkTask,
                        token,
                        myAddress,
                        sinceIso,
                        context.conversationId || null,
                        context.anchorSubject || task.subject || '',
                        { linkedInContext }
                    );
                } catch (err) {
                    console.warn('[Specter-Outreach] Deep reply check fallback failed:', err);
                }
            }
            return false;
        })()
        : Promise.resolve(false);

    const linkedinPromise = contactLinkedIn
        ? (async () => {
            try {
                return await detectLinkedInReply({
                    ...task,
                    contactLinkedIn,
                    linkedinProfile: task.linkedinProfile || contactLinkedIn,
                    linkedin: task.linkedin || contactLinkedIn,
                    linkedinUrl: task.linkedinUrl || contactLinkedIn,
                    company,
                }, normalizedSinceDate, { linkedInContext });
            } catch (err) {
                console.warn('[Specter-Outreach] LinkedIn reply lookup failed:', err);
                return false;
            }
        })()
        : Promise.resolve(false);

    const [emailResponse, linkedinResponse] = await Promise.all([emailPromise, linkedinPromise]);

    return Boolean(emailResponse || linkedinResponse);
}

export async function buildLinkedInBatchContext(tasks = [], unipileAccountId = null) {
    if (!UNIPILE_API_KEY || !UNIPILE_API_URL) return null;
    if (!Array.isArray(tasks) || !tasks.length) return null;

    const normalizedTasks = tasks.map(taskRow => ({
        task: taskRow,
        context: normalizeTaskContext(taskRow?.context)
    }));

    const hasCandidates = normalizedTasks.some(({ task, context }) => (
        Boolean(resolveTaskLinkedInCandidate(task, context))
    ));

    if (!hasCandidates) {
        return null;
    }

    if (!unipileAccountId) {
        return null;
    }

    const context = {
        accountId: unipileAccountId,
        chatRecord: null,
        chatIdCache: new Map(),
        profileCache: new Map()
    };

    try {
        context.chatRecord = await getLinkedInChats(unipileAccountId, { logContext: { scope: 'batch-evaluation' } });
    } catch (err) {
        console.warn('[Specter-Outreach][Debug] LinkedIn chat prefetch failed', err);
        context.chatRecord = null;
    }

    return context;
}

let isProcessingOverdueTasks = false;

export async function processOverdueTasks(payload = {}) {
    if (isProcessingOverdueTasks) {
        console.log('[Specter-Outreach] Already processing overdue tasks, skipping.');
        return { processed: 0, skipped: 0, responded: 0, concurrent_skip: true };
    }
    isProcessingOverdueTasks = true;
    try {
        return await processOverdueTasksInternal(payload);
    } finally {
        isProcessingOverdueTasks = false;
    }
}

export async function processOverdueTasksInternal(payload = {}) {
    const user = payload.user || {};
    const unipileAccountId = payload.unipileAccountId || null;
    const forceDeepCheck = !!payload.forceDeepCheck;
    const normalizedEmail = normalizeEmail(user.email);
    console.log('[Specter-Outreach][Debug] processOverdueTasksInternal', {
        userEmail: normalizedEmail,
        forceDeepCheck,
        hasUnipile: !!unipileAccountId
    });
    if (!normalizedEmail) {
        return { processed: 0, skipped: 0, responded: 0 };
    }

    const userId = await ensureSupabaseUser({ ...user, email: normalizedEmail });
    if (!userId) return { processed: 0, skipped: 0, responded: 0 };

    const summary = { processed: 0, skipped: 0, responded: 0 };
    const [overdueTasks, upcomingTasks] = await Promise.all([
        fetchOverdueTasks({ userId, userEmail: normalizedEmail }),
        fetchUpcomingTasksForUser({ userId, userEmail: normalizedEmail })
    ]);

    if (!overdueTasks.length && !upcomingTasks.length) {
        return summary;
    }

    const ensureToken = async () => {
        return payload.msToken || null;
    };

    const allTasksForLookup = [...upcomingTasks, ...overdueTasks];
    const linkedInContext = await buildLinkedInBatchContext(allTasksForLookup, unipileAccountId);

    const evaluateFounderResponse = async (taskRow) => {
        const task = { ...taskRow, context: normalizeTaskContext(taskRow.context) };
        const triggerDate = new Date(task.trigger_date || Date.now());
        const baseline = Number.isFinite(triggerDate.getTime()) ? triggerDate : new Date();
        let since = new Date(baseline.getTime() - 30 * 24 * 60 * 60 * 1000);

        if (task.created_at) {
            const createdAt = new Date(task.created_at);
            if (!Number.isNaN(createdAt.valueOf()) && createdAt > since) {
                since = createdAt;
            }
        }

        const sinceIso = since.toISOString();

        const company = task.company || {};
        const context = task.context || {};
        let contactEmail = String(context.contactEmail || company.email || '').trim();
        if (!contactEmail && Array.isArray(context.toList) && context.toList.length) {
            contactEmail = String(context.toList[0] || '').trim();
        }
        const tokenForCheck = contactEmail ? await ensureToken() : null;
        const responded = await hasFounderRespondedForTask(task, {
            token: tokenForCheck,
            sinceIso,
            linkedInContext,
            forceDeepCheck,
            myAddress: normalizedEmail
        });
        if (responded) {
            await deleteSupabaseTask(task.id);
            summary.responded += 1;
            return { task, responded: true };
        }

        return { task, responded: false };
    };

    await Promise.all(upcomingTasks.map(evaluateFounderResponse));

    const overdueEvaluations = await Promise.all(overdueTasks.map(evaluateFounderResponse));

    for (const { task, responded } of overdueEvaluations) {
        if (responded) {
            continue;
        }

        const label = String(task.upcoming_task || '').toLowerCase();

        try {
            if (/linkedin/.test(label)) {
                const result = await executeLinkedInSupabaseTask(task, unipileAccountId);
                if (result === 'sent') {
                    summary.processed += 1;
                } else if (result === 'responded') {
                    summary.responded += 1;
                } else {
                    summary.skipped += 1;
                }
                continue;
            }

            if (/email/.test(label)) {
                const result = await sendEmailFollowupFromSupabase(task, { ensureToken, linkedInContext });
                if (result === 'sent') {
                    summary.processed += 1;
                } else if (result === 'responded') {
                    summary.responded += 1;
                } else {
                    summary.skipped += 1;
                }
                continue;
            }

            if (/partner/.test(label)) {
                const result = await sendPartnerForwardTask(task, { ensureToken });
                if (result === 'sent') {
                    summary.processed += 1;
                } else if (result === 'responded') {
                    summary.responded += 1;
                } else {
                    summary.skipped += 1;
                }
                continue;
            }

            summary.skipped += 1;
        } catch (err) {
            console.warn('[Specter-Outreach] Overdue task execution failed:', err);
            summary.skipped += 1;
        }
    }

    console.log('[Specter-Outreach] Overdue task processing summary', summary);
    return summary;
}

export async function sendEmailFollowupFromSupabase(task, { ensureToken, linkedInContext }) {
    const context = normalizeTaskContext(task.context);
    const company = task.company || {};
    const partnerName = task.partner?.name || context.partnerName || '';
    const followUpTemplate = String(task.message_text || context.followUpTemplate || '').trim();

    if (!followUpTemplate) {
        console.warn('[Specter-Outreach] Follow-up email task missing template text', task?.id);
        return 'missing_template';
    }

    if (!Object.keys(context).length) {
        console.warn('[Specter-Outreach] Supabase task missing follow-up context', task?.id);
        return 'missing_context';
    }

    let token = await ensureToken();
    if (!token) {
        console.warn('[Specter-Outreach] Cannot send email follow-up without Outlook token');
        return 'token_unavailable';
    }

    const followupTask = {
        messageId: context.messageId || context.originalMessageId || null,
        conversationId: context.conversationId || null,
        anchorId: context.anchorId || context.anchorMessageId || null,
        anchorConversationId: context.anchorConversationId || context.conversationId || null,
        anchorSentAt: context.anchorSentAt || context.sentAt || null,
        originalSentAt: context.originalSentAt
            || context.anchorSentAt
            || context.sentAt
            || task.trigger_date
            || new Date().toISOString(),
        scheduledAt: context.scheduledAt || context.storedAt || task.trigger_date || Date.now(),
        subject: context.subject || '',
        followUpTemplate,
        signatureHtml: context.signatureHtml || '',
        appendSignature: !!context.appendSignature,
        calendly: context.calendly || '',
        partnerName,
        contactName: context.contactName || company.contact_person || '',
        contactEmail: context.contactEmail || company.email || '',
        companyName: context.companyName || company.name || '',
        contactLinkedIn: context.contactLinkedIn || company.linkedin || null,
        linkedinProfile: context.linkedinProfile || context.contactLinkedIn || company.linkedin || null,
        toList: Array.isArray(context.toList) ? context.toList : [],
        storedAt: context.storedAt || null
    };

    followupTask.contactFirstName = context.contactFirstName
        || extractFirstName(followupTask.contactName || '')
        || extractFirstName(company.contact_person || '');

    try {
        const me = await fetchJSON('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', token);
        const myAddress = (me.mail || me.userPrincipalName || '').toLowerCase();

        const anchor = await resolveAnchorMessage(followupTask, token, myAddress);
        if (!anchor?.id) {
            console.warn('[Specter-Outreach] Unable to resolve follow-up anchor message for task', task.id);
            return 'no_anchor';
        }

        let sinceDate = new Date(
            anchor.sentDateTime
            || followupTask.anchorSentAt
            || followupTask.originalSentAt
            || followupTask.scheduledAt
        );
        if (Number.isNaN(sinceDate.valueOf())) {
            sinceDate = new Date();
        }

        if (task.created_at) {
            const createdAt = new Date(task.created_at);
            if (!Number.isNaN(createdAt.valueOf()) && createdAt > sinceDate) {
                sinceDate = createdAt;
            }
        }

        const sinceIso = sinceDate.toISOString();

        const replied = await detectReply(followupTask, token, myAddress, sinceIso, anchor.conversationId, anchor.subject, { linkedInContext });
        if (replied) {
            await deleteSupabaseTask(task.id);
            console.log('[Specter-Outreach] Skipping email follow-up due to detected reply', task.id);
            return 'responded';
        }

        const replyDraft = await fetchJSON(`https://graph.microsoft.com/v1.0/me/messages/${anchor.id}/createReplyAll`, token, {
            method: 'POST'
        });

        let calendlyLink = '';
        if (followupTask.calendly) {
            const url = followupTask.calendly.match(/^https?:\/\//i)
                ? followupTask.calendly
                : `https://${followupTask.calendly}`;
            calendlyLink = `<a href="${url}">here is my Calendly</a>`;
        }

        const followupText = applyTemplateReplacements(followupTask.followUpTemplate, {
            '{{calendly}}': calendlyLink,
            '{{firstName}}': followupTask.contactFirstName || '',
            '{{partnerName}}': partnerName || ''
        });
        let followupHtml = buildHtmlBodyForBg(followupText, followupTask.signatureHtml, followupTask.appendSignature);

        if (replyDraft?.body?.content) {
            followupHtml += replyDraft.body.content;
        }

        await fetchJSON(`https://graph.microsoft.com/v1.0/me/messages/${replyDraft.id}`, token, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: { contentType: 'HTML', content: followupHtml } })
        });

        await fetchJSON(`https://graph.microsoft.com/v1.0/me/messages/${replyDraft.id}/send`, token, { method: 'POST' });

        await deleteSupabaseTask(task.id);
        console.log('[Specter-Outreach] Follow-up email sent for task', task.id);
        return 'sent';
    } catch (err) {
        console.warn('[Specter-Outreach] Email follow-up execution failed:', err);
        return 'error';
    }
}

export async function sendPartnerForwardTask(task, { ensureToken }) {
    const context = normalizeTaskContext(task.context);
    const partnerEmail = context.partnerEmail || task?.partner?.email || null;
    if (!partnerEmail) {
        console.warn('[Specter-Outreach] Partner task missing partner email', task?.id);
        return 'missing_partner';
    }

    let token = await ensureToken();
    if (!token) {
        console.warn('[Specter-Outreach] Cannot forward to partner without Outlook token');
        return 'token_unavailable';
    }

    const company = task.company || {};
    const contactName = context.contactName || company.contact_person || '';
    const contactFirstName = context.contactFirstName || extractFirstName(contactName);
    const partnerName = context.partnerName || task.partner?.name || '';
    const bodyText = applyTemplateReplacements(String(task.message_text || ''), {
        '{{firstName}}': contactFirstName || '',
        '{{partnerName}}': partnerName || ''
    });
    const bodyHtml = buildHtmlBodyForBg(bodyText, null, false);
    const subject = context.subject
        || `Forward to partner: ${context.companyName || company.name || 'Opportunity'}`;

    try {
        await fetchJSON('https://graph.microsoft.com/v1.0/me/sendMail', token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: {
                    subject,
                    body: { contentType: 'HTML', content: bodyHtml },
                    toRecipients: [{ emailAddress: { address: partnerEmail } }]
                },
                saveToSentItems: true
            })
        });
        await deleteSupabaseTask(task.id);
        console.log('[Specter-Outreach] Partner forward sent for task', task.id);
        return 'sent';
    } catch (err) {
        console.warn('[Specter-Outreach] Partner forwarding failed:', err);
        return 'error';
    }
}

export async function executeLinkedInSupabaseTask(task, unipileAccountId = null) {
    const context = normalizeTaskContext(task.context);
    const company = task.company || {};
    const linkedinProfile = context.contactLinkedIn
        || context.linkedinProfile
        || company.linkedin
        || null;
    if (!linkedinProfile) {
        console.warn('[Specter-Outreach] LinkedIn task missing contact profile', task?.id);
        return 'missing_linkedin';
    }

    const accountId = unipileAccountId;
    if (!accountId) {
        console.warn('[Specter-Outreach] LinkedIn task waiting for Unipile connection');
        return 'missing_account';
    }

    const rawTemplate = String(task.message_text || context.message || '').trim();
    const contactName = context.contactName || company.contact_person || '';
    const contactFirstName = context.contactFirstName || extractFirstName(contactName);
    const partnerName = context.partnerName || task.partner?.name || '';
    const calendly = context.calendly || '';
    const message = applyTemplateReplacements(rawTemplate, {
        '{{firstName}}': contactFirstName || '',
        '{{partnerName}}': partnerName || '',
        '{{calendly}}': calendly || ''
    }).trim();
    if (!message) {
        console.warn('[Specter-Outreach] LinkedIn task missing message text', task?.id);
        return 'missing_message';
    }

    try {
        await runLinkedInTask({
            task: {
                message,
                contactLinkedIn: linkedinProfile,
                linkedinProfile,
                contactEmail: context.contactEmail || company.email || null,
                contactName: contactName || null,
                companyName: context.companyName || company.name || null
            },
            accountId
        });
        await deleteSupabaseTask(task.id);
        console.log('[Specter-Outreach] LinkedIn task sent for task', task.id);
        return 'sent';
    } catch (err) {
        console.warn('[Specter-Outreach] LinkedIn task execution failed:', err);
        return 'error';
    }
}

export async function detectReply(task, token, myAddress, sinceIso, conversationId, anchorSubject, options = {}) {
    const since = new Date(sinceIso);
    console.log('[Specter-Outreach][Debug] detectReply start', { taskId: task.id, sinceIso, conversationId, subject: task.subject, anchorSubject });

    if (conversationId) {
        try {
            const url = new URL('https://graph.microsoft.com/v1.0/me/messages');
            url.searchParams.set('$filter', `conversationId eq ${odataQuote(conversationId)}`);
            url.searchParams.set('$orderby', 'receivedDateTime desc');
            url.searchParams.set('$top', '50');
            url.searchParams.set('$select', 'id,from,receivedDateTime');
            const list = await fetchJSON(url.toString(), token);
            const vals = list.value || [];
            const someoneElse = vals.find(m => {
                const fromAddr = (m.from?.emailAddress?.address || '').toLowerCase();
                const received = new Date(m.receivedDateTime || 0);
                return received > since && fromAddr && fromAddr !== myAddress;
            });
            if (someoneElse) {
                console.log('[Specter-Outreach][Debug] Reply detected via conversationId', { msgId: someoneElse.id, from: someoneElse.from });
                return true;
            }
        } catch (e) {
            console.warn('[Specter-Outreach] Conversation reply check failed; continuing:', e);
        }
    }

    const recipients = Array.isArray(task.toList) ? task.toList : [];
    for (const addr of recipients) {
        try {
            const urlInbox = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
            urlInbox.searchParams.set('$filter', `from/emailAddress/address eq ${odataQuote(String(addr).toLowerCase())}`);
            urlInbox.searchParams.set('$orderby', 'receivedDateTime desc');
            urlInbox.searchParams.set('$top', '25');
            urlInbox.searchParams.set('$select', 'id,receivedDateTime');
            const list = await fetchJSON(urlInbox.toString(), token);
            const vals = list.value || [];
            if (vals.some(m => new Date(m.receivedDateTime || 0) > since)) {
                console.log('[Specter-Outreach][Debug] Reply detected via Inbox check', { addr });
                return true;
            }
        } catch (e) {
            console.warn('[Specter-Outreach] Inbox reply check failed for', addr, e);
        }
    }

    const base = normalizeSubjectBase(anchorSubject || task.subject || '');
    console.log('[Specter-Outreach][Debug] Subject check base:', base);
    if (base) {
        try {
            const urlSearch = new URL('https://graph.microsoft.com/v1.0/me/messages');
            urlSearch.searchParams.set('$search', `"subject:${base}"`);
            urlSearch.searchParams.set('$top', '25');
            urlSearch.searchParams.set('$select', 'id,from,toRecipients,ccRecipients,receivedDateTime,subject');
            const list = await fetchJSON(urlSearch.toString(), token, { headers: { 'ConsistencyLevel': 'eventual' } });
            const vals = list.value || [];

            const isMe = (a) => (a || '').toLowerCase() === myAddress;
            const meOnThread = (m) => [...(m.toRecipients || []), ...(m.ccRecipients || [])]
                .some(r => isMe(r.emailAddress?.address || ''));

            const replyFound = vals.find(m => {
                const received = new Date(m.receivedDateTime || 0);
                const fromAddr = (m.from?.emailAddress?.address || '').toLowerCase();
                const mBase = normalizeSubjectBase(m.subject || '');
                const subjOk = mBase && mBase.startsWith(base);
                // Debug log for potential matches
                if (mBase.includes(base) || base.includes(mBase)) {
                    console.log('[Specter-Outreach][Debug] Subject match candidate', {
                        id: m.id,
                        subject: m.subject,
                        mBase,
                        base,
                        subjOk,
                        receivedIso: received.toISOString(),
                        sinceIso: since.toISOString(),
                        fromAddr,
                        isMe: isMe(fromAddr)
                    });
                }
                return received > since && !isMe(fromAddr) && meOnThread(m);
            });

            if (replyFound) {
                console.log('[Specter-Outreach][Debug] Reply detected via Subject check', { msgId: replyFound.id, subject: replyFound.subject });
                return true;
            }
        } catch (e) {
            console.warn('[Specter-Outreach] Subject $search check failed:', e);
        }
    }

    try {
        const linkedInReply = await detectLinkedInReply(task, since, options);
        if (linkedInReply) return true;
    } catch (err) {
        console.warn('[Specter-Outreach] LinkedIn reply check failed:', err);
    }

    console.log('[Specter-Outreach][Debug] No reply detected');
    return false;
}