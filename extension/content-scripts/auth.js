// content-scripts/auth.js

import { sendMessageWithTimeout } from './utils.js';
import { updateLoginUI, setStatus, showLoginButton, updateUnipileButtonState } from './ui.js';
import {
    setMsToken, setUserInfo, setSpecterLastOverdueProcessMs, setUnipileAccountId,
    unipileAccountId, userInfo, msToken
} from './state.js';

export async function loginOutlook(fetchAndStoreUserProfile, widgetQuery) {
    setStatus('Authenticating with Microsoft...', widgetQuery);

    const res = await chrome.runtime.sendMessage({ type: 'GET_MS_TOKEN' });

    if (res?.ok) {
        await fetchAndStoreUserProfile(res.token);
    } else {
        setStatus('Login failed: ' + (res?.error || 'Unknown error'), widgetQuery);
        showLoginButton(widgetQuery);
    }
}

export async function logoutOutlook(stopUnipilePolling, widgetQuery, setLinkedInFollowUpAvailability) {
    try {
        await chrome.storage.local.remove(['msToken', 'userInfo']);

        setMsToken(null);
        setUserInfo(null);
        setSpecterLastOverdueProcessMs(0);
        stopUnipilePolling();
        setUnipileAccountId(null);
        updateUnipileButtonState(null, widgetQuery, setLinkedInFollowUpAvailability);
        chrome.storage.sync.remove('unipileAccountId', () => { });

        showLoginButton(widgetQuery);
        setStatus('Logged out of Outlook.', widgetQuery);
        console.log('[Specter-Outreach] User logged out.');
    } catch (e) {
        console.error('[Specter-Outreach] Logout error:', e);
        setStatus('Logout error: ' + e.message, widgetQuery);
    }
}

export async function fetchAndStoreUserProfile(token, triggerOverdueTaskProcessing, refreshWorkflowSnapshot, syncUnipileStatus, widgetQuery) {
    try {
        const res = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { 'Authorization': 'Bearer ' + token }
        });

        if (!res.ok) throw new Error('Failed to fetch user profile');

        const profile = await res.json();

        const newUserInfo = {
            firstName: profile.givenName,
            lastName: profile.surname,
            displayName: profile.displayName || profile.userPrincipalName,
            email: (profile.mail || profile.userPrincipalName || '').toLowerCase()
        };

        await chrome.storage.local.set({ msToken: token, userInfo: newUserInfo });

        setMsToken(token);
        setUserInfo(newUserInfo);

        updateLoginUI(newUserInfo.displayName, widgetQuery);
        setStatus('Outlook connected.', widgetQuery);

        if (unipileAccountId && newUserInfo.email) {
            sendMessageWithTimeout('UPSERT_USER_UNIPILE_ID', {
                email: newUserInfo.email,
                unipileId: unipileAccountId,
                userInfo: {
                    email: newUserInfo.email,
                    displayName: newUserInfo.displayName || newUserInfo.userPrincipalName || '',
                    firstName: newUserInfo.firstName || newUserInfo.givenName || '',
                    lastName: newUserInfo.lastName || newUserInfo.surname || ''
                }
            }, 15000)
                .then(res => {
                    if (!res?.ok) {
                        console.warn('[Specter-Outreach] Unable to sync Unipile id after Outlook login:', res);
                    }
                })
                .catch(err => console.warn('[Specter-Outreach] Unipile sync after Outlook login failed:', err));
        }

        syncUnipileStatus({ silent: true });
        triggerOverdueTaskProcessing('login');

        try {
            if (typeof refreshWorkflowSnapshot === 'function') {
                await refreshWorkflowSnapshot();
            }
        } catch (err) {
            console.warn('[Specter-Outreach] Workflow snapshot refresh after login failed:', err);
        }
    } catch (err) {
        console.error('[Specter-Outreach] Profile fetch error:', err);
        setStatus('Could not fetch Outlook profile.', widgetQuery);
        showLoginButton(widgetQuery);
    }
}

export async function checkStoredLogin(fetchAndStoreUserProfile, triggerOverdueTaskProcessing, syncUnipileStatus, widgetQuery) {
    try {
        const { msToken: storedToken, userInfo: storedUserInfo } = await chrome.storage.local.get(['msToken', 'userInfo']);

        if (storedToken && storedUserInfo && storedUserInfo.displayName) {
            const res = await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: { 'Authorization': 'Bearer ' + storedToken }
            });

            if (res.ok) {
                console.log('[Specter-Outreach] Stored token is valid.');
                setMsToken(storedToken);
                setUserInfo(storedUserInfo);
                updateLoginUI(storedUserInfo.displayName, widgetQuery);
                setStatus('Outlook connected.', widgetQuery);
                syncUnipileStatus({ silent: true });
                await triggerOverdueTaskProcessing('extension-open');
            } else {
                console.log('[Specter-Outreach] Stored token expired.');
                showLoginButton(widgetQuery);
                setStatus('Session expired. Please log in again.', widgetQuery);
            }
        } else {
            showLoginButton(widgetQuery);
        }
    } catch (err) {
        console.warn('[Specter-Outreach] Could not check stored login:', err);
        showLoginButton(widgetQuery);
    }
}
