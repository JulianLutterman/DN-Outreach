(() => {

    if (window.__specterContentScriptInjected) {
        console.debug('[Specter-Outreach] content script already initialized; skipping reinjection.');
        if (typeof window.__specterReinitialize === 'function') {
            try {
                const maybePromise = window.__specterReinitialize();
                if (maybePromise && typeof maybePromise.then === 'function') {
                    maybePromise.catch(err => {
                        console.error('[Specter-Outreach] Widget reinitialization failed:', err);
                    });
                }
            } catch (err) {
                console.error('[Specter-Outreach] Widget reinitialization threw synchronously:', err);
            }
        }
    } else {
        window.__specterContentScriptInjected = true;

        /* global chrome, window, document, fetch, history, location */

        // ---------- Initialization & Re-injection Protection ----------

        window.__specterSleep = window.__specterSleep || ((ms) => new Promise(r => setTimeout(r, ms)));
        window.__affinityCompanyIdentifiers = window.__affinityCompanyIdentifiers || null;

        window.__affinityLastDomain = window.__affinityLastDomain || null;
        window.__affinityDidInitialCheck = window.__affinityDidInitialCheck || false;

        window.__unipileAccountId = window.__unipileAccountId || null;
        window.__unipilePollTimerId = window.__unipilePollTimerId || null;
        window.__unipilePollNoticeTimeoutId = window.__unipilePollNoticeTimeoutId || null;

        window.__specterDefaultModelId = window.__specterDefaultModelId || 'deepseek/deepseek-v3.1-terminus';

        // Models are now loaded dynamically from config.js, but we keep a default here or load them.
        // We'll load modules shortly.

        window.__specterGetModelLabelById = window.__specterGetModelLabelById || function (id) {
            // This will be updated once config is loaded
            const m = (window.__specterModelOptions || []).find(x => x.id === id);
            return m ? m.label : id;
        };

        window.__activeFounderContact = window.__activeFounderContact || null;
        window.__companyContext = window.__companyContext || null;

        let workflowUtilsModulePromise = null;

        // Dynamic imports
        const loadModules = async () => {
            const [
                utils,
                ui,
                extraction,
                workflow,
                auth,
                state,
                workflowUtils
            ] = await Promise.all([
                import(chrome.runtime.getURL('content-scripts/utils.js')),
                import(chrome.runtime.getURL('content-scripts/ui.js')),
                import(chrome.runtime.getURL('content-scripts/extraction.js')),
                import(chrome.runtime.getURL('content-scripts/workflow.js')),
                import(chrome.runtime.getURL('content-scripts/auth.js')),
                import(chrome.runtime.getURL('content-scripts/state.js')),
                import(chrome.runtime.getURL('workflowUtils.js'))
            ]);
            return { utils, ui, extraction, workflow, auth, state, workflowUtils };
        };

        (async () => {
            console.log('[Specter-Outreach] Content script executing');

            if (window.__specterOutreachInjected) {
                console.log('[Specter-Outreach] Widget already injected, abort');
                return;
            }
            window.__specterOutreachInjected = true;

            const modules = await loadModules();
            const { utils, ui, extraction, workflow, auth, state, workflowUtils } = modules;

            // Fetch UI config from backend
            const BACKEND_URL = 'https://dnoutreach.vercel.app';
            const UNIPILE_POLL_INTERVAL_MS = 5000; // Default value
            let configData = null;
            try {
                const configRes = await fetch(`${BACKEND_URL}/api/ui/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const configResult = await configRes.json();
                if (configResult.ok && configResult.config) {
                    configData = configResult.config;
                    window.__specterModelOptions = configData.modelOptions || [];
                    window.__specterDefaultModelId = configData.defaultModelId || 'deepseek/deepseek-v3.1-terminus';
                }
            } catch (err) {
                console.warn('[Specter-Outreach] Failed to load config from backend, using defaults:', err);
                window.__specterModelOptions = [];
                window.__specterDefaultModelId = 'deepseek/deepseek-v3.1-terminus';
            }

            window.__specterGetModelLabelById = function (id) {
                const m = (window.__specterModelOptions || []).find(x => x.id === id);
                return m ? m.label : id;
            };

            // Helper to get elements from within the shadow DOM
            const widgetQuery = (selector) => {
                const root = document.getElementById('specter-outreach-root');
                return root?.shadowRoot?.querySelector(selector) || null;
            };
            window.__specterWidgetQuery = widgetQuery;

            const $ = widgetQuery;

            // State variables from modules/state

            window.__specterLastOverdueProcessMs = window.__specterLastOverdueProcessMs || 0;

            async function triggerOverdueTaskProcessing(reason = 'unspecified') {
                if (!window.__userInfo || !window.__userInfo.email) return;

                const now = Date.now();
                if (now - window.__specterLastOverdueProcessMs < 15_000 && reason !== 'login') {
                    return;
                }

                try {
                    const res = await utils.sendMessageWithTimeout('PROCESS_OVERDUE_TASKS', {
                        user: window.__userInfo,
                        reason
                    }, 20000);
                    if (res?.ok) {
                        window.__specterLastOverdueProcessMs = now;
                    } else if (res) {
                        console.warn('[Specter-Outreach] Overdue task processing failed:', res);
                    }
                } catch (err) {
                    console.warn('[Specter-Outreach] Overdue task processing threw:', err);
                }
            }

            function stopUnipilePolling() {
                if (window.__unipilePollTimerId) {
                    clearTimeout(window.__unipilePollTimerId);
                    window.__unipilePollTimerId = null;
                    console.log('[Unipile][poll] cleared tick timer');
                }
                if (window.__unipilePollNoticeTimeoutId) {
                    clearTimeout(window.__unipilePollNoticeTimeoutId);
                    window.__unipilePollNoticeTimeoutId = null;
                    console.log('[Unipile][poll] cleared notice timer');
                }
            }

            function beginUnipilePolling({ knownAccountIds = [], userProfile, showNotice = true }) {
                console.log('[Unipile][poll] begin', { knownAccountIds, showNotice, userProfile });
                stopUnipilePolling();

                if (showNotice) {
                    if (window.__unipilePollNoticeTimeoutId) {
                        clearTimeout(window.__unipilePollNoticeTimeoutId);
                    }
                    window.__unipilePollNoticeTimeoutId = setTimeout(() => {
                        if (!window.__unipileAccountId) {
                            ui.setStatus('Still waiting for Unipile to finish LinkedIn connection...', widgetQuery);
                        }
                    }, UNIPILE_POLL_INTERVAL_MS * 12);
                }

                async function tick(previousKnown = knownAccountIds) {
                    console.log('[Unipile][poll] tick start', { previousKnown });
                    try {
                        const res = await utils.sendMessageWithTimeout('CHECK_UNIPILE_LINKEDIN_ACCOUNT', { knownAccountIds: previousKnown, user: userProfile }, 15000);
                        console.log('[Unipile][poll] tick response', res);
                        const nextKnown = Array.isArray(res?.knownAccountIds) ? res.knownAccountIds : previousKnown;

                        if (res?.ok && res.accountId) {
                            await persistUnipileAccount(res.accountId, { silent: false, account: res.account || null });
                            stopUnipilePolling();
                            return;
                        }

                        window.__unipilePollTimerId = setTimeout(() => tick(nextKnown), UNIPILE_POLL_INTERVAL_MS);
                    } catch (err) {
                        console.warn('[Specter-Outreach] Unipile polling error:', err);
                        window.__unipilePollTimerId = setTimeout(() => tick(previousKnown), UNIPILE_POLL_INTERVAL_MS);
                    }
                }

                tick(knownAccountIds);
            }

            async function persistUnipileAccount(accountId, { silent = false, account = null } = {}) {
                if (!accountId) return;

                const isSameAccount = window.__unipileAccountId === accountId;
                console.log('[Unipile][persist] storing account', accountId, { silent, isSameAccount, hasAccountDetails: !!account });
                stopUnipilePolling();
                window.__unipileAccountId = accountId;
                if (account) {
                    window.__unipileAccountDetails = account;
                }
                ui.updateUnipileButtonState(accountId, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));

                if (!isSameAccount) {
                    try {
                        await new Promise((resolve, reject) => {
                            chrome.storage.sync.set({ unipileAccountId: accountId }, () => {
                                if (chrome.runtime.lastError) {
                                    reject(chrome.runtime.lastError);
                                } else {
                                    resolve();
                                }
                            });
                        });
                        console.log('[Unipile][persist] chrome.storage updated');
                    } catch (err) {
                        console.warn('[Specter-Outreach] Failed to persist Unipile account id to storage:', err);
                    }
                }

                const email = (window.__userInfo?.email || '').toLowerCase();
                const accountDetails = account || window.__unipileAccountDetails || null;
                const derivedLinkedIn = utils.deriveLinkedInFromAccount(accountDetails);

                if (email) {
                    const userInfoPayload = {
                        email,
                        displayName: window.__userInfo?.displayName || window.__userInfo?.userPrincipalName || '',
                        firstName: window.__userInfo?.firstName || window.__userInfo?.givenName || '',
                        lastName: window.__userInfo?.lastName || window.__userInfo?.surname || ''
                    };

                    if (derivedLinkedIn) {
                        userInfoPayload.linkedin = derivedLinkedIn;
                    }

                    const res = await utils.sendMessageWithTimeout('UPSERT_USER_UNIPILE_ID', {
                        email,
                        unipileId: accountId,
                        userInfo: userInfoPayload,
                        accountDetails: accountDetails || undefined
                    }, 15000);
                    if (!res?.ok) {
                        console.warn('[Specter-Outreach] Failed to update Supabase with Unipile id:', res);
                    }
                    if (!silent) {
                        if (res?.ok) {
                            ui.setStatus('LinkedIn connected via Unipile.', widgetQuery);
                        } else {
                            ui.setStatus('LinkedIn connected via Unipile, but syncing to Supabase failed.', widgetQuery);
                        }
                    }
                } else if (!silent) {
                    ui.setStatus('LinkedIn connected via Unipile. (Outlook email unavailable for Supabase sync.)', widgetQuery);
                }
            }

            async function syncUnipileStatus({ silent = false } = {}) {
                console.log('[Unipile][sync] invoked', { silent, user: window.__userInfo });
                if (!window.__userInfo || !window.__userInfo.email) {
                    if (!silent) ui.setStatus('Please connect Outlook before syncing Unipile.', widgetQuery);
                    return;
                }

                try {
                    const res = await utils.sendMessageWithTimeout('SYNC_UNIPILE_STATUS', { user: window.__userInfo }, 15000);
                    console.log('[Unipile][sync] response', res);
                    if (res?.ok && res.accountId) {
                        if (window.__unipileAccountId !== res.accountId || res.account) {
                            await persistUnipileAccount(res.accountId, { silent, account: res.account || null });
                        } else {
                            ui.updateUnipileButtonState(window.__unipileAccountId, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                        }
                        stopUnipilePolling();
                    } else {
                        if (res?.ok && !res.accountId && window.__unipileAccountId) {
                            try {
                                await new Promise(resolve => chrome.storage.sync.remove('unipileAccountId', () => resolve()));
                            } catch (err) {
                                console.warn('[Specter-Outreach] Failed to clear stored Unipile id:', err);
                            }
                            window.__unipileAccountId = null;
                            window.__unipileAccountDetails = null;
                        }
                        if (Array.isArray(res?.knownAccountIds) && res.knownAccountIds.length && window.__userInfo) {
                            beginUnipilePolling({ knownAccountIds: res.knownAccountIds, userProfile: window.__userInfo, showNotice: !silent });
                        } else if (!window.__unipileAccountId) {
                            stopUnipilePolling();
                        }
                        ui.updateUnipileButtonState(window.__unipileAccountId || null, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                    }
                } catch (err) {
                    console.warn('[Specter-Outreach] Unipile status sync failed:', err);
                    ui.updateUnipileButtonState(window.__unipileAccountId || null, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                }
            }

            async function startUnipileLinkedInLogin() {
                if (!window.__userInfo) {
                    ui.setStatus('Connect Outlook before linking LinkedIn.', widgetQuery);
                    return;
                }

                console.log('[Unipile][ui] start login', { hasAccount: !!window.__unipileAccountId, user: window.__userInfo });
                if (window.__unipileAccountId) {
                    stopUnipilePolling();
                    ui.setStatus('LinkedIn already connected via Unipile.', widgetQuery);
                    ui.updateUnipileButtonState(window.__unipileAccountId, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                    return;
                }

                stopUnipilePolling();
                const btn = widgetQuery('#unipileBtn');
                if (btn) btn.disabled = true;

                try {
                    ui.setStatus('Requesting LinkedIn login link from Unipile...', widgetQuery);
                    const res = await utils.sendMessageWithTimeout('GENERATE_UNIPILE_LINKEDIN_LOGIN', { user: window.__userInfo || {} }, 15000);
                    console.log('[Unipile][ui] generate result', res);

                    const knownIds = Array.isArray(res?.knownAccountIds) ? res.knownAccountIds : [];
                    if (res?.alreadyConnected && res.accountId) {
                        await persistUnipileAccount(res.accountId, { silent: false, account: res.account || null });
                        ui.setStatus('LinkedIn already connected via Unipile.', widgetQuery);
                        return;
                    }

                    if (!res?.ok || !res.url) {
                        const reason = res?.error ? ' (' + res.error + ')' : '';
                        ui.setStatus('Could not start Unipile login' + reason + '. Check configuration.', widgetQuery);
                        return;
                    }

                    window.open(res.url, '_blank', 'noopener,noreferrer');
                    ui.setStatus('LinkedIn login opened in a new tab via Unipile. Complete it there and leave this tab open.', widgetQuery);

                    beginUnipilePolling({ knownAccountIds: knownIds, userProfile: window.__userInfo || {} });
                } catch (err) {
                    ui.setStatus('Unipile login failed: ' + (err?.message || err), widgetQuery);
                } finally {
                    if (btn) btn.disabled = !!window.__unipileAccountId;
                    ui.updateUnipileButtonState(window.__unipileAccountId || null, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                }
            }

            async function injectWidget() {
                if (document.getElementById('specter-outreach-root')) return;

                // Fetch widget HTML from backend
                let widgetHTML;
                try {
                    const BACKEND_URL = 'https://dnoutreach.vercel.app';
                    const response = await fetch(`${BACKEND_URL}/api/ui/widget-html`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    });
                    const result = await response.json();
                    if (result.ok && result.html) {
                        widgetHTML = result.html;
                    } else {
                        console.error('[Specter-Outreach] Failed to fetch widget HTML from backend');
                        return;
                    }
                } catch (err) {
                    console.error('[Specter-Outreach] Error fetching widget HTML:', err);
                    return;
                }

                const root = document.createElement('div');
                root.id = 'specter-outreach-root';
                Object.assign(root.style, {
                    position: 'fixed',
                    top: '24px',
                    right: '24px',
                    zIndex: 999999,
                    fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif'
                });

                const shadowRoot = root.attachShadow({ mode: 'open' });
                document.body.appendChild(root);
                shadowRoot.innerHTML = widgetHTML;

                ui.makeResizable(shadowRoot.querySelector('#specter-outreach-panel'));
                ui.makeDraggableWithinWindow(root, shadowRoot);

                ui.setLinkedInFollowUpAvailability(!!window.__unipileAccountId, widgetQuery);
                ui.updateUnipileButtonState(window.__unipileAccountId || null, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                if (window.__userInfo) syncUnipileStatus({ silent: true });

                const modelSelect = widgetQuery('#modelSelect');
                if (modelSelect && window.__specterModelOptions?.length) {
                    modelSelect.innerHTML = (window.__specterModelOptions || [])
                        .map(o => '<option value="' + o.id + '">' + o.label + '</option>')
                        .join('');
                }

                // Wrapper for auth
                const wrappedFetchAndStore = async (token) => {
                    await auth.fetchAndStoreUserProfile(token, triggerOverdueTaskProcessing, () => refreshWorkflowSnapshot({ $, workflowUtils }), syncUnipileStatus, widgetQuery);
                };

                await auth.checkStoredLogin(wrappedFetchAndStore, triggerOverdueTaskProcessing, syncUnipileStatus, widgetQuery);

                try {
                    const {
                        calendlyLink = '',
                        linkedinUrl: storedLinkedinUrl = '',
                        ccList = '',
                        signatureHtml = '',
                        appendSignature = true,
                        autoFollowUp = false,
                        followUpTemplate = 'Quick nudge on this. Would love to connect for 30 minutes. Here is my Calendly: {{calendly}}',
                        modelId = window.__specterDefaultModelId,
                        unipileAccountId: storedUnipileAccountId = null,
                        linkedinMessage: storedLinkedinMessage = '',
                        partnerMessage: storedPartnerMessage = '',
                        followUpTrigger: storedFollowUpTrigger = '',
                        linkedinTrigger: storedLinkedinTrigger = '',
                        partnerTrigger: storedPartnerTrigger = ''
                    } = await chrome.storage.sync.get([
                        'calendlyLink', 'linkedinUrl', 'ccList', 'signatureHtml', 'appendSignature',
                        'autoFollowUp', 'followUpTemplate', 'modelId', 'unipileAccountId',
                        'linkedinMessage', 'partnerMessage', 'followUpTrigger', 'linkedinTrigger', 'partnerTrigger'
                    ]);

                    const $id = (id) => widgetQuery('#' + id);

                    $id('calendly').value = calendlyLink;
                    $id('linkedin').value = storedLinkedinUrl || '';
                    $id('cc').value = ccList;
                    if (storedUnipileAccountId) {
                        window.__unipileAccountId = storedUnipileAccountId;
                    }
                    ui.updateUnipileButtonState(window.__unipileAccountId || null, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                    $id('signatureHtml').value = signatureHtml;
                    $id('appendSignature').checked = !!appendSignature;
                    $id('autoFollowUp').checked = !!autoFollowUp;
                    $id('followUpTemplate').value = followUpTemplate;
                    ui.rememberTemplateBaseline($id('followUpTemplate'), followUpTemplate);
                    $id('linkedinMessage').value = storedLinkedinMessage || $id('linkedinMessage').placeholder;
                    ui.rememberTemplateBaseline($id('linkedinMessage'), storedLinkedinMessage || $id('linkedinMessage').placeholder || '');
                    $id('partnerMessage').value = storedPartnerMessage || $id('partnerMessage').placeholder;
                    ui.rememberTemplateBaseline($id('partnerMessage'), storedPartnerMessage || $id('partnerMessage').placeholder || '');
                    if (storedFollowUpTrigger) $id('followUpTrigger').value = storedFollowUpTrigger;
                    if (storedLinkedinTrigger) $id('linkedinTrigger').value = storedLinkedinTrigger;
                    if (storedPartnerTrigger) $id('partnerTrigger').value = storedPartnerTrigger;

                    if (modelSelect) {
                        modelSelect.value = modelId;
                    }

                    workflow.initializeWorkflowDefaults(widgetQuery);
                } catch (err) {
                    console.warn('[Specter-Outreach] Could not access chrome.storage:', err);
                    ui.updateUnipileButtonState(window.__unipileAccountId || null, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery));
                }

                shadowRoot.addEventListener('blur', e => {
                    const id = e?.target?.id;
                    if (!id) return;

                    if ([
                        'calendly', 'linkedin', 'cc', 'signatureHtml', 'appendSignature',
                        'autoFollowUp', 'followUpTemplate', 'modelSelect',
                        'linkedinMessage', 'partnerMessage', 'followUpTrigger', 'linkedinTrigger', 'partnerTrigger'
                    ].includes(id)) {
                        chrome.storage.sync.set({
                            calendlyLink: widgetQuery('#calendly').value,
                            linkedinUrl: widgetQuery('#linkedin')?.value || '',
                            ccList: widgetQuery('#cc').value,
                            signatureHtml: widgetQuery('#signatureHtml').value,
                            appendSignature: widgetQuery('#appendSignature').checked,
                            autoFollowUp: widgetQuery('#autoFollowUp').checked,
                            followUpTemplate: widgetQuery('#followUpTemplate').value,
                            modelId: (widgetQuery('#modelSelect')?.value || window.__specterDefaultModelId),
                            linkedinMessage: widgetQuery('#linkedinMessage')?.value || '',
                            partnerMessage: widgetQuery('#partnerMessage')?.value || '',
                            followUpTrigger: widgetQuery('#followUpTrigger')?.value || '',
                            linkedinTrigger: widgetQuery('#linkedinTrigger')?.value || '',
                            partnerTrigger: widgetQuery('#partnerTrigger')?.value || ''
                        });
                        if (['followUpTemplate', 'linkedinMessage', 'partnerMessage'].includes(id)) {
                            const target = e.target;
                            if (target?.value && target.value.includes('{{')) {
                                target.dataset.templateBase = target.value;
                            }
                            if (target?.dataset?.autoFilledValue) {
                                delete target.dataset.autoFilledValue;
                            }
                        }
                    }
                }, true);

                if (modelSelect) {
                    modelSelect.addEventListener('change', () => {
                        chrome.storage.sync.set({ modelId: modelSelect.value });
                    });
                }

                const $id = (id) => widgetQuery('#' + id);
                $id('loginBtn').addEventListener('click', () => auth.loginOutlook(wrappedFetchAndStore, widgetQuery));
                $id('logoutBtn').addEventListener('click', () => auth.logoutOutlook(stopUnipilePolling, widgetQuery, (connected) => ui.setLinkedInFollowUpAvailability(connected, widgetQuery)));
                $id('closeBtn').addEventListener('click', closeWidget);
                $id('generateBtn').addEventListener('click', generateEmail);
                $id('sendBtn').addEventListener('click', sendEmail);
                const addDealBtn = $id('addDealPipelineBtn');
                if (addDealBtn) addDealBtn.addEventListener('click', addCompanyToDealPipeline);
                const unipileBtn = $id('unipileBtn');
                if (unipileBtn) unipileBtn.addEventListener('click', startUnipileLinkedInLogin);

                const partnerSelect = $id('partnerSelect');
                if (partnerSelect) {
                    partnerSelect.addEventListener('change', (event) => {
                        workflow.handlePartnerSelectionChange(event, widgetQuery);
                        workflow.updateWorkflowPreviewUI($, workflowUtils, state.workflowSnapshot, widgetQuery);
                    });
                    state.setPartnerRecords(await workflow.hydratePartnerPicker($, utils.sendMessageWithTimeout, ui.setStatus, widgetQuery) || []);
                } else {
                    state.setPartnerEmailLookup(new Map());
                    state.setSelectedPartnerEmails(new Set());
                }

                if (modelSelect && $id('generateBtn')) {
                    const syncGenerateLabel = () => {
                        $id('generateBtn').textContent = 'Generate Email';
                    };
                    syncGenerateLabel();
                    modelSelect.addEventListener('change', syncGenerateLabel);
                }

                const workflowFieldIds = [
                    'autoFollowUp', 'followUpTrigger', 'followUpTemplate',
                    'linkedinFollowUpToggle', 'linkedinTrigger', 'linkedinMessage',
                    'partnerEscalationToggle', 'partnerTrigger', 'partnerMessage', 'partnerForwardSelect'
                ];

                workflowFieldIds.forEach(id => {
                    const el = $id(id);
                    if (!el) return;
                    const handler = () => {
                        if (id === 'partnerForwardSelect') {
                            ui.autoFillFollowUpMessages(widgetQuery);
                        }
                        workflow.updateWorkflowPreviewUI($, workflowUtils, state.workflowSnapshot, widgetQuery);
                    };
                    el.addEventListener('change', handler);
                    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
                        el.addEventListener('input', handler);
                    }
                });

                workflow.updateWorkflowPreviewUI($, workflowUtils, state.workflowSnapshot, widgetQuery, true);
                refreshWorkflowSnapshot({ $, workflowUtils });

                try {
                    const context = extraction.updateCompanyContextFromPage();
                    const identifiers = deriveAffinityIdentifiers(context || null);
                    const domainChanged = identifiers.domain && identifiers.domain !== window.__affinityLastDomain;

                    if (!window.__affinityDidInitialCheck || domainChanged) {
                        await refreshAffinityDealPipeline(context || null, { force: true });
                        window.__affinityLastDomain = identifiers.domain || null;
                        window.__affinityDidInitialCheck = true;
                    } else {
                        await refreshAffinityDealPipeline(context || null);
                    }
                } catch (e) {
                    console.warn('[Specter-Outreach] Initial Affinity check failed:', e);
                    await refreshAffinityDealPipeline(null);
                }
            }

            function closeWidget() {
                const root = document.getElementById('specter-outreach-root');
                if (root) {
                    root.remove();
                    console.log('[Specter-Outreach] Widget closed by user');
                }
                window.__specterOutreachInjected = false;
                window.__specterWidgetQuery = null;
            }

            window.__specterReinitialize = async function specterReinitialize() {
                const root = document.getElementById('specter-outreach-root');
                if (root) {
                    root.style.display = '';
                    console.debug('[Specter-Outreach] Widget already present; no reinjection needed.');
                    return;
                }

                try {
                    console.debug('[Specter-Outreach] Re-injecting widget after close.');
                    window.__specterOutreachInjected = true;
                    await injectWidget();
                } catch (err) {
                    window.__specterOutreachInjected = false;
                    console.error('[Specter-Outreach] Failed to re-inject widget:', err);
                    throw err;
                }
            };

            injectWidget();

            // SPA Handling
            const pushState = history.pushState;
            history.pushState = function () {
                pushState.apply(this, arguments);
                setTimeout(checkRoute, 50);
            };
            window.addEventListener('popstate', checkRoute);

            function checkRoute() {
                if (!document.getElementById('specter-outreach-root')) {
                    console.log('[Specter-Outreach] Route change re-injecting');
                    injectWidget();
                }
            }

            // --- Core Business Logic Functions adapted to use modules ---

            async function refreshWorkflowSnapshot({ $, workflowUtils }) {
                try {
                    const context = window.__companyContext || extraction.updateCompanyContextFromPage();
                    const domain = context?.domain || utils.extractDomainFromUrl(context?.website || '') || (location.hostname || '');
                    const companyName = context?.companyName || '';
                    const response = await utils.sendMessageWithTimeout('FETCH_WORKFLOW_SNAPSHOT', {
                        domain,
                        companyName,
                        user: window.__userInfo || {}
                    }, 15000);
                    if (response?.ok) {
                        state.setWorkflowSnapshot(response.data || state.workflowSnapshot);
                        workflow.renderPipelineTasks($, state.workflowSnapshot.outstandingTasks || [], widgetQuery, utils.sendMessageWithTimeout, (msg) => ui.setStatus(msg, widgetQuery), () => refreshWorkflowSnapshot({ $, workflowUtils }));
                        workflow.updateWorkflowPreviewUI($, workflowUtils, state.workflowSnapshot, widgetQuery);
                    }
                } catch (err) {
                    console.warn('[Specter-Outreach] Workflow snapshot failed:', err);
                }
            }

            function deriveAffinityIdentifiers(source) {
                if (!source) return { domain: '', domains: [], name: '' };

                const domainCandidates = [];
                const pushDomainCandidate = (value) => {
                    if (!value || typeof value !== 'string') return;
                    const trimmed = value.trim();
                    if (!trimmed) return;
                    if (!domainCandidates.includes(trimmed)) {
                        domainCandidates.push(trimmed);
                    }
                };

                const locationDomain = utils.extractDomainFromUrl((location?.hostname || location?.href || '') || '');
                if (locationDomain) {
                    pushDomainCandidate(locationDomain);
                }

                const collect = (obj) => {
                    if (!obj || typeof obj !== 'object') return;
                    const maybe = [
                        obj.domain,
                        obj.website,
                        obj.website_url,
                        obj.websiteUrl,
                        obj.company_domain,
                        obj.organization_domain,
                        obj.homepage,
                        obj.url
                    ];
                    maybe.forEach(pushDomainCandidate);
                };

                collect(source);
                if (source.company) collect(source.company);

                const normalizedDomains = [];
                let domain = '';
                for (const candidate of domainCandidates) {
                    if (!candidate) continue;
                    let value = candidate;
                    try {
                        const parsed = new URL(candidate.startsWith('http') ? candidate : 'https://' + candidate);
                        value = parsed.hostname;
                    } catch (err) {
                        value = candidate.replace(/^https?:\/\//, '');
                    }
                    value = value.replace(/\/.*$/, '').replace(/^www\./, '');
                    if (value) {
                        const normalized = value.toLowerCase();
                        if (!normalizedDomains.includes(normalized)) {
                            normalizedDomains.push(normalized);
                        }
                        if (!domain) {
                            domain = normalized;
                        }
                    }
                }

                const nameCandidates = [];
                const pushName = (value) => {
                    if (typeof value === 'string') {
                        const trimmed = value.trim();
                        if (trimmed && !nameCandidates.includes(trimmed)) nameCandidates.push(trimmed);
                    }
                };

                pushName(source.companyName);
                pushName(source.name);
                pushName(source.organization_name);
                pushName(source.company_name);
                pushName(source.legal_name);
                if (source.company) {
                    pushName(source.company.organization_name);
                    pushName(source.company.name);
                    pushName(source.company.company_name);
                    pushName(source.company.legal_name);
                }

                const name = nameCandidates.find(Boolean) || '';

                return { domain, domains: normalizedDomains, name };
            }

            async function refreshAffinityDealPipeline(company, { force = false } = {}) {
                const indicator = widgetQuery('#affinityDealIndicator');
                const button = widgetQuery('#addDealPipelineBtn');
                if (!indicator || !button) return;

                if (!company) {
                    indicator.textContent = 'Open a company profile to check Affinity.';
                    indicator.className = 'affinity-indicator';
                    button.style.display = 'none';
                    button.disabled = true;
                    window.__affinityCompanyIdentifiers = null;
                    return;
                }

                const identifiers = deriveAffinityIdentifiers(company);
                window.__affinityCompanyIdentifiers = identifiers;

                if (!identifiers.domain && !identifiers.name) {
                    indicator.textContent = 'Missing company info for Affinity lookup.';
                    indicator.className = 'affinity-indicator not-in-pipeline';
                    button.style.display = 'none';
                    button.disabled = true;
                    return;
                }

                indicator.textContent = 'Checking Deal Pipeline';
                indicator.className = 'affinity-indicator';
                button.style.display = 'none';
                button.disabled = true;

                const res = await utils.sendMessageWithTimeout('GET_AFFINITY_DEAL_STATUS', identifiers, 60000);

                if (!res?.ok) {
                    indicator.textContent = 'Not in Deal Pipeline';
                    indicator.className = 'affinity-indicator not-in-pipeline';
                    button.style.display = 'inline-block';
                    button.disabled = false;
                    if (res?.error && res.error !== 'timeout') {
                        ui.setStatus('Affinity error: ' + res.error, widgetQuery);
                    }
                    return;
                }

                const data = res.data || {};
                if (data.inPipeline) {
                    const statusText = data.status?.text || 'No status set';
                    indicator.textContent = 'Deal Pipeline: ' + statusText;
                    indicator.className = 'affinity-indicator in-pipeline';
                    button.style.display = 'none';
                    button.disabled = true;
                } else {
                    indicator.textContent = 'Not in Deal Pipeline';
                    indicator.className = 'affinity-indicator not-in-pipeline';
                    button.style.display = 'inline-block';
                    button.disabled = false;
                }
            }

            async function addCompanyToDealPipeline() {
                const indicator = widgetQuery('#affinityDealIndicator');
                const button = widgetQuery('#addDealPipelineBtn');
                if (!indicator || !button) return;

                const identifiers = window.__affinityCompanyIdentifiers;
                if (!identifiers || (!identifiers.domain && !identifiers.name)) {
                    ui.setStatus('Cannot add to Affinity: missing company information.', widgetQuery);
                    return;
                }

                indicator.textContent = 'Adding to Deal Pipeline';
                indicator.className = 'affinity-indicator';
                button.disabled = true;

                try {
                    const res = await chrome.runtime.sendMessage({
                        type: 'ADD_TO_DEAL_PIPELINE',
                        payload: identifiers
                    });

                    if (!res?.ok) {
                        throw new Error(res?.error || 'Unknown Affinity error');
                    }

                    ui.setStatus('Company added to Affinity Deal Pipeline.', widgetQuery);
                    await refreshAffinityDealPipeline(window.__companyContext || null, { force: true });
                } catch (error) {
                    console.error('[Specter-Outreach] Failed to add company to Deal Pipeline:', error);
                    indicator.textContent = 'Add to Deal Pipeline failed';
                    indicator.className = 'affinity-indicator not-in-pipeline';
                    button.disabled = false;
                    ui.setStatus('Affinity error: ' + error.message, widgetQuery);
                }
            }

            async function generateEmail() {
                const context = extraction.updateCompanyContextFromPage();
                if (!context?.website) {
                    ui.setStatus('Unable to identify the company website. Please open a profile with a website link.', widgetQuery);
                    return;
                }

                window.__companyContext = context;
                window.__activeFounderContact = null;

                await triggerOverdueTaskProcessing('generate-email');

                const modelId = (widgetQuery('#modelSelect')?.value) || window.__specterDefaultModelId;
                const modelLabel = window.__specterGetModelLabelById(modelId);
                const calendly = widgetQuery('#calendly').value.trim();
                // Ensure userInfo is available
                let userInfo = window.__userInfo;
                console.log('[Specter-Outreach] Current window.__userInfo:', userInfo);

                if (!userInfo || !userInfo.displayName || !userInfo.displayName.trim()) {
                    console.log('[Specter-Outreach] userInfo missing or incomplete, checking storage...');
                    const stored = await chrome.storage.local.get('userInfo');
                    console.log('[Specter-Outreach] Storage result:', stored);

                    if (stored.userInfo && stored.userInfo.displayName) {
                        userInfo = stored.userInfo;
                        window.__userInfo = userInfo;
                        console.log('[Specter-Outreach] Restored userInfo from storage:', userInfo);
                    } else {
                        // Attempt one last fetch if we have a token
                        const tokenData = await chrome.storage.local.get('msToken');
                        if (tokenData.msToken) {
                            console.log('[Specter-Outreach] Token found, attempting to fetch profile...');
                            try {
                                const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                                    headers: { 'Authorization': 'Bearer ' + tokenData.msToken }
                                });
                                if (profileRes.ok) {
                                    const profile = await profileRes.json();
                                    userInfo = {
                                        firstName: profile.givenName,
                                        lastName: profile.surname,
                                        displayName: profile.displayName || profile.userPrincipalName,
                                        email: (profile.mail || profile.userPrincipalName || '').toLowerCase()
                                    };
                                    window.__userInfo = userInfo;
                                    await chrome.storage.local.set({ userInfo });
                                    console.log('[Specter-Outreach] Fetched fresh profile:', userInfo);
                                }
                            } catch (err) {
                                console.error('[Specter-Outreach] Profile fetch failed:', err);
                            }
                        }
                    }
                }

                // Final fallback: Scrape from UI if visible
                if (!userInfo || !userInfo.displayName || !userInfo.displayName.trim()) {
                    const statusText = widgetQuery('#loginStatus')?.textContent || '';
                    if (statusText.includes('Logged in as ')) {
                        const name = statusText.replace('Logged in as ', '').trim();
                        if (name) {
                            console.log('[Specter-Outreach] Recovered user name from UI:', name);
                            userInfo = { displayName: name };
                            window.__userInfo = userInfo;
                        }
                    }
                }

                if (!userInfo || ((!userInfo.displayName || !userInfo.displayName.trim()) && (!userInfo.firstName || !userInfo.firstName.trim()))) {
                    console.error('[Specter-Outreach] Critical: UserInfo is still missing or empty after all attempts.', userInfo);
                    ui.setStatus('Error: Could not identify user. Please log out and log in again.', widgetQuery);
                    return;
                }

                console.log('[Specter-Outreach] Sending payload to backend:', {
                    companyContext: context,
                    calendlyLink: calendly,
                    userInfo,
                    modelId
                });

                // Status simulation removed. Using real-time updates via SSE.

                try {
                    // Call comprehensive backend endpoint with streaming
                    const response = await fetch(`${BACKEND_URL}/api/email/generate-complete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            companyContext: context,
                            calendlyLink: calendly,
                            userInfo,
                            modelId
                        })
                    });

                    if (!response.ok) {
                        const errText = await response.text();
                        let errMsg = 'Unknown backend error';
                        try {
                            const json = JSON.parse(errText);
                            errMsg = json.error || errMsg;
                        } catch (e) {
                            errMsg = errText || errMsg;
                        }
                        throw new Error(errMsg);
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let result = null;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n\n');
                        buffer = lines.pop(); // Keep incomplete chunk

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonStr = line.slice(6);
                                try {
                                    const event = JSON.parse(jsonStr);
                                    if (event.type === 'progress') {
                                        ui.setStatus(event.message, widgetQuery);
                                    } else if (event.type === 'result') {
                                        result = event.data;
                                    } else if (event.type === 'error') {
                                        throw new Error(event.error);
                                    }
                                } catch (e) {
                                    console.warn('[Specter-Outreach] Failed to parse SSE event:', e);
                                    if (e.message !== 'Unexpected end of JSON input') {
                                        // If it's a real error from the stream, rethrow
                                        if (jsonStr.includes('"type":"error"')) throw e;
                                    }
                                }
                            }
                        }
                    }

                    if (!result) {
                        throw new Error('Stream ended without result');
                    }

                    if (!result.ok) {
                        throw new Error(result.error || 'Unknown backend error');
                    }

                    // Update UI with result
                    const subjectField = widgetQuery('#subject');
                    const bodyField = widgetQuery('#emailBox'); // Changed from #emailBody to #emailBox based on original code

                    if (subjectField) subjectField.value = result.subject || '';
                    if (bodyField) {
                        bodyField.value = result.body || '';
                        // Trigger input event to resize if needed
                        bodyField.dispatchEvent(new Event('input', { bubbles: true }));
                    }

                    // Handle founder contact info
                    if (result.founderContact) {
                        const founder = result.founderContact;
                        const domainForContact = window.__companyContext?.domain || '';

                        window.__activeFounderContact = {
                            fullName: founder.fullName,
                            firstName: founder.firstName,
                            lastName: founder.lastName,
                            email: founder.email || '',
                            linkedin: founder.linkedin || '',
                            domain: domainForContact || '',
                            relevantExperience: founder.relevantExperience || ''
                        };

                        // Update UI fields if they exist
                        const fName = widgetQuery('#founderName');
                        const fEmail = widgetQuery('#founderEmail');
                        const fLinkedin = widgetQuery('#founderLinkedin');

                        if (fName) fName.value = founder.fullName || '';
                        if (fEmail) fEmail.value = founder.email || '';
                        if (fLinkedin) fLinkedin.value = founder.linkedin || '';
                    }

                    ui.autoFillFollowUpMessages(widgetQuery);

                    // Set generated email
                    widgetQuery('#subject').value = result.subject || 'Following up';
                    widgetQuery('#emailBox').value = result.body || '';
                    widgetQuery('#sendBtn').disabled = false;

                    ui.setStatus('Email generated successfully!', widgetQuery);

                } catch (e) {
                    console.error('[Specter-Outreach] Generation error:', e);
                    ui.setStatus('Error: ' + e.message, widgetQuery);
                }
            }

            async function sendEmail() {
                if (!window.__companyContext) {
                    return ui.setStatus('No company data loaded. Please generate email first.', widgetQuery);
                }

                const sendBtn = widgetQuery('#sendBtn');
                const partnerEscalationToggle = widgetQuery('#partnerEscalationToggle');
                const partnerForwardSelect = widgetQuery('#partnerForwardSelect');

                if (partnerEscalationToggle?.checked) {
                    const selectedPartnerValue = partnerForwardSelect?.value || '';
                    if (!selectedPartnerValue) {
                        if (sendBtn) {
                            const currentLabel = sendBtn.textContent || 'Send';
                            if (!sendBtn.dataset.originalLabel) {
                                sendBtn.dataset.originalLabel = currentLabel;
                            }
                            sendBtn.disabled = true;
                            sendBtn.textContent = 'You forgot to select a partner to forward to';
                            if (state.forwardPartnerReminderTimeoutId) {
                                clearTimeout(state.forwardPartnerReminderTimeoutId);
                            }
                            state.forwardPartnerReminderTimeoutId = setTimeout(() => {
                                const btn = widgetQuery('#sendBtn');
                                if (!btn) return;
                                btn.disabled = false;
                                const original = btn.dataset.originalLabel || 'Send';
                                btn.textContent = original;
                                state.forwardPartnerReminderTimeoutId = null;
                            }, 5000);
                        }
                        return;
                    }
                }

                if (state.forwardPartnerReminderTimeoutId) {
                    clearTimeout(state.forwardPartnerReminderTimeoutId);
                    state.forwardPartnerReminderTimeoutId = null;
                }
                if (sendBtn?.dataset?.originalLabel) {
                    sendBtn.textContent = sendBtn.dataset.originalLabel;
                    sendBtn.disabled = false;
                }

                const toRaw = widgetQuery('#to').value.trim();
                const toList = toRaw ? toRaw.split(/[;,]/).map(x => x.trim()).filter(Boolean) : [];
                if (!toList.length) return ui.setStatus('"To" field cannot be empty.', widgetQuery);

                const successStatusMessage = 'E-mail sent!';
                const statusEl = widgetQuery('#status');
                const previousStatusText = statusEl ? statusEl.textContent : '';
                const originalSendLabel = sendBtn?.dataset?.originalLabel || sendBtn?.textContent || 'Send';

                const restoreSendButton = (message) => {
                    if (sendBtn) {
                        sendBtn.disabled = false;
                        sendBtn.textContent = sendBtn.dataset.originalLabel || originalSendLabel;
                    }
                    if (typeof message === 'string') {
                        ui.setStatus(message, widgetQuery);
                    } else if (previousStatusText) {
                        ui.setStatus(previousStatusText, widgetQuery);
                    } else {
                        ui.setStatus('', widgetQuery);
                    }
                };

                if (sendBtn) {
                    if (!sendBtn.dataset.originalLabel) {
                        sendBtn.dataset.originalLabel = originalSendLabel;
                    } else {
                        sendBtn.textContent = sendBtn.dataset.originalLabel;
                    }
                    sendBtn.disabled = true;
                }
                ui.setStatus(successStatusMessage, widgetQuery);

                await triggerOverdueTaskProcessing('email-send');

                if (window.__activeFounderContact) {
                    window.__activeFounderContact.email = toList[0] || window.__activeFounderContact.email || '';
                }

                const founderLinkedInRaw = widgetQuery('#linkedin')?.value?.trim() || window.__activeFounderContact?.linkedin || '';
                const founderLinkedIn = founderLinkedInRaw ? utils.ensureHttpUrl(founderLinkedInRaw) : '';
                const contactName = (window.__activeFounderContact?.fullName
                    || window.__activeFounderContact?.name
                    || window.__companyContext?.founder?.fullName
                    || '').trim();
                const companyName = (window.__companyContext?.companyName || '').trim();
                const primaryEmail = toList[0] || '';

                const subject = widgetQuery('#subject').value;
                const messageBody = widgetQuery('#emailBox').value;

                const ccRaw = widgetQuery('#cc').value.trim();
                const ccList = ccRaw ? ccRaw.split(/[;,]/).map(x => x.trim()).filter(Boolean) : [];

                const signatureHtml = widgetQuery('#signatureHtml').value;
                const appendSignature = widgetQuery('#appendSignature').checked;

                const finalHtml = utils.buildHtmlBody(messageBody, signatureHtml, appendSignature);

                let draft;
                try {
                    const createDraftRes = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
                        method: 'POST',
                        headers: {
                            'Authorization': 'Bearer ' + window.__msToken,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            subject,
                            body: { contentType: 'HTML', content: finalHtml },
                            toRecipients: toList.map(addr => ({ emailAddress: { address: addr } })),
                            ccRecipients: ccList.map(addr => ({ emailAddress: { address: addr } }))
                        })
                    });

                    if (!createDraftRes.ok) {
                        const err = await createDraftRes.text();
                        restoreSendButton('Create draft failed: ' + err);
                        return;
                    }

                    draft = await createDraftRes.json();

                    const sendRes = await fetch('https://graph.microsoft.com/v1.0/me/messages/' + draft.id + '/send', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + window.__msToken }
                    });

                    if (!sendRes.ok) {
                        const err = await sendRes.text();
                        restoreSendButton('Send failed: ' + err);
                        console.error('Microsoft Graph API Error:', err);
                        return;
                    }
                } catch (err) {
                    console.error('[Specter-Outreach] Unexpected error while sending email:', err);
                    restoreSendButton('Send failed: ' + (err?.message || err));
                    return;
                }

                ui.setStatus(successStatusMessage, widgetQuery);
                widgetQuery('#sendBtn').disabled = true;

                let anchor = null;
                try {
                    async function findSentAnchorOnce({ subject, toList, msToken }) {
                        const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages');
                        url.searchParams.set('$orderby', 'sentDateTime desc');
                        url.searchParams.set('$top', '50');
                        url.searchParams.set('$select', 'id,conversationId,sentDateTime,subject,toRecipients,ccRecipients');

                        const res = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + msToken } });
                        if (!res.ok) throw new Error(await res.text());

                        const data = await res.json();
                        const items = Array.isArray(data.value) ? data.value : [];

                        const base = utils.normalizeSubjectBase(subject);
                        const want = new Set((toList || []).map(utils.normalizeEmail));

                        for (const m of items) {
                            const mBase = utils.normalizeSubjectBase(m.subject || '');
                            if (!mBase || !mBase.startsWith(base)) continue;

                            const recips = [
                                ...((m.toRecipients || []).map(r => r.emailAddress?.address) || []),
                                ...((m.ccRecipients || []).map(r => r.emailAddress?.address) || [])
                            ].map(utils.normalizeEmail);

                            const hasAny = recips.some(r => want.has(r));
                            if (!hasAny) continue;

                            return { id: m.id, conversationId: m.conversationId, sentDateTime: m.sentDateTime, subject: m.subject };
                        }
                        return null;
                    }

                    for (let i = 0; i < 10; i++) {
                        try {
                            anchor = await findSentAnchorOnce({ subject, toList, msToken: window.__msToken });
                            if (anchor) break;
                        } catch (e) {
                            console.warn('[Specter-Outreach] Anchor lookup error (attempt ' + (i + 1) + '):', e);
                        }
                        await utils.sleep(1500);
                    }

                    if (anchor) {
                        console.log('[Specter-Outreach] Captured anchor', anchor);
                    } else {
                        console.warn('[Specter-Outreach] Could not capture anchor in Sent Items (will fallback in BG).');
                    }
                } catch (e) {
                    console.warn('[Specter-Outreach] Anchor capture failed:', e);
                }

                const steps = workflow.collectWorkflowStepConfigs(widgetQuery);
                const calendly = widgetQuery('#calendly')?.value?.trim() || '';
                const partnerForwardOption = partnerForwardSelect?.selectedOptions?.[0] || null;
                const partnerForwardEmail = partnerForwardOption?.dataset?.email || '';
                const partnerForwardName = partnerForwardOption && partnerForwardOption.value ? String(partnerForwardOption.textContent || '').trim() : '';
                const contactFirstName = window.__activeFounderContact?.firstName
                    || window.__activeFounderContact?.givenName
                    || window.__activeFounderContact?.name
                    || (contactName ? contactName.split(/\s+/)[0] : '');
                const nowIso = new Date().toISOString();

                const stepsWithContext = steps.map(step => {
                    const normalized = { ...step };
                    const label = (step.label || step.key || '').toLowerCase();
                    const baseContext = {
                        contactName,
                        contactFirstName,
                        contactEmail: primaryEmail,
                        companyName,
                        partnerName: partnerForwardName,
                        partnerEmail: partnerForwardEmail
                    };

                    if (/email/.test(label)) {
                        normalized.context = {
                            ...baseContext,
                            messageId: draft.id || null,
                            originalMessageId: draft.id || null,
                            conversationId: draft.conversationId || null,
                            anchorId: anchor?.id || null,
                            anchorConversationId: anchor?.conversationId || draft.conversationId || null,
                            anchorSentAt: anchor?.sentDateTime || null,
                            originalSentAt: anchor?.sentDateTime || nowIso,
                            storedAt: nowIso,
                            scheduledAt: step.trigger || '',
                            subject,
                            toList,
                            signatureHtml,
                            appendSignature,
                            calendly,
                            contactLinkedIn: founderLinkedIn || '',
                            linkedinProfile: founderLinkedIn || '',
                            followUpTemplate: step.message || ''
                        };
                    } else if (/linkedin/.test(label)) {
                        normalized.context = {
                            ...baseContext,
                            contactLinkedIn: founderLinkedIn || '',
                            linkedinProfile: founderLinkedIn || '',
                            calendly
                        };
                    } else if (/partner/.test(label)) {
                        normalized.context = {
                            ...baseContext,
                            subject: 'Forward to partner: ' + (companyName || 'Opportunity')
                        };
                    }

                    return normalized;
                });

                const syncResult = await syncCompanyToSupabase({
                    toList,
                    steps: stepsWithContext,
                    fallbackPartnerId: state.workflowSnapshot?.fallbackPartnerId || null
                });

                if (syncResult?.ok && Array.isArray(syncResult.tasks)) {
                    state.workflowSnapshot.tasks = syncResult.tasks;
                    workflow.updateWorkflowPreviewUI($, workflowUtils, state.workflowSnapshot, widgetQuery);
                    refreshWorkflowSnapshot({ $, workflowUtils });
                }

                await triggerOverdueTaskProcessing('email-sent');
            }

            async function syncCompanyToSupabase({ toList = [], steps = [], fallbackPartnerId = null } = {}) {
                try {
                    const companyContext = window.__companyContext || {};
                    const companyName = (companyContext?.companyName || '').trim();
                    const websiteCandidate = companyContext?.website || '';
                    const linkedinField = widgetQuery('#linkedin')?.value?.trim() || '';
                    const linkedInFinal = linkedinField || window.__activeFounderContact?.linkedin || '';
                    const contactName = (window.__activeFounderContact?.fullName
                        || window.__activeFounderContact?.name
                        || companyContext?.founder?.fullName
                        || '').trim();
                    const primaryEmail = (toList[0] || window.__activeFounderContact?.email || '').trim();

                    if (!companyName || !contactName || !primaryEmail) {
                        console.warn('[Specter-Outreach] Skipping Supabase insert - missing fields.', { companyName, contactName, primaryEmail });
                        return;
                    }

                    const payload = {
                        name: companyName,
                        website: websiteCandidate || null,
                        contact_person: contactName,
                        email: primaryEmail,
                        linkedin: linkedInFinal ? utils.ensureHttpUrl(linkedInFinal) : null
                    };

                    const res = await utils.sendMessageWithTimeout('UPSERT_COMPANY', payload, 15000);
                    if (!res?.ok) {
                        console.warn('[Specter-Outreach] Supabase insert failed:', res);
                        ui.setStatus('E-mail sent! (Supabase sync failed - see console.)', widgetQuery);
                        return res;
                    }

                    const companyRecord = res.data || {};
                    let taskResult = { ok: true, data: [] };

                    if (Array.isArray(steps) && steps.length) {
                        const userInfo = window.__userInfo || {};
                        const normalizedUserEmail = (userInfo.email || userInfo.mail || userInfo.userPrincipalName || '').toLowerCase();
                        if (!normalizedUserEmail) {
                            console.warn('[Specter-Outreach] Cannot sync workflow tasks without a user email.');
                        } else {
                            const taskResponse = await utils.sendMessageWithTimeout('UPSERT_TASKS', {
                                companyId: companyRecord.id,
                                steps,
                                user: {
                                    email: normalizedUserEmail,
                                    name: userInfo.displayName || userInfo.givenName || '',
                                    linkedin: widgetQuery('#linkedin')?.value?.trim() || ''
                                },
                                fallbackPartnerId,
                                contact: {
                                    name: contactName,
                                    email: primaryEmail,
                                    linkedin: linkedInFinal ? utils.ensureHttpUrl(linkedInFinal) : null
                                },
                                company: {
                                    name: companyName
                                }
                            }, 20000);

                            if (!taskResponse?.ok) {
                                console.warn('[Specter-Outreach] Failed to insert workflow tasks:', taskResponse);
                            } else {
                                taskResult = { ok: true, data: taskResponse.data || [] };
                            }
                        }
                    }

                    ui.setStatus('E-mail sent! Company & workflow saved to Supabase.', widgetQuery);
                    return { ok: true, company: companyRecord, tasks: taskResult.data || [] };
                } catch (err) {
                    console.warn('[Specter-Outreach] Supabase sync error:', err);
                    ui.setStatus('E-mail sent! (Supabase sync error - see console.)', widgetQuery);
                    return { ok: false, error: err?.message || 'sync-error' };
                }
            }

        })();
    }

})();
