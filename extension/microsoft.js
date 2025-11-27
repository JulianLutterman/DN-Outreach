// background-scripts/microsoft.js

import { CLIENT_ID, SCOPES } from './config.js';
import { normalizeEmail, storageLocalGet } from './utils.js';

export function buildAuthUrl({ interactive = true, loginHint } = {}) {
    const redirectUri = chrome.identity.getRedirectURL();
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'token',
        redirect_uri: redirectUri,
        scope: SCOPES,
        prompt: interactive ? 'select_account' : 'none'
    });
    if (loginHint) params.set('login_hint', loginHint);
    return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + params.toString();
}

export async function getAccessToken({ interactive = true, loginHint } = {}) {
    const url = buildAuthUrl({ interactive, loginHint });
    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url, interactive }, redirectResponse => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            if (!redirectResponse) return reject(new Error('No response from auth flow'));
            const fragment = new URL(redirectResponse).hash.substring(1);
            const params = new URLSearchParams(fragment);
            const token = params.get('access_token');
            if (token) return resolve(token);
            reject(new Error(params.get('error_description') || 'No access_token in redirect'));
        });
    });
}

export async function resolveActiveOutlookSession() {
    try {
        const { msToken, userInfo } = await storageLocalGet(['msToken', 'userInfo']);
        if (!msToken || !userInfo) {
            return { email: null, userInfo: null };
        }
        const email = normalizeEmail(userInfo.email);
        if (!email) {
            return { email: null, userInfo: null };
        }
        return { email, userInfo: { ...userInfo, email } };
    } catch (err) {
        console.warn('[Specter-Outreach] Unable to resolve active Outlook session:', err);
        return { email: null, userInfo: null };
    }
}
