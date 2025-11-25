// background-scripts/utils.js

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeEmail(value) {
    if (!value) return '';
    return String(value).trim().toLowerCase();
}

export async function storageLocalGet(keys) {
    if (!chrome?.storage?.local?.get) {
        return {};
    }

    return await new Promise((resolve) => {
        try {
            chrome.storage.local.get(keys, (items) => {
                if (chrome.runtime?.lastError) {
                    console.warn('[Specter-Outreach] chrome.storage.local.get failed:', chrome.runtime.lastError);
                    resolve({});
                    return;
                }
                resolve(items || {});
            });
        } catch (err) {
            console.warn('[Specter-Outreach] chrome.storage.local.get threw:', err);
            resolve({});
        }
    });
}
