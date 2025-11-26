// background-scripts/hunter.js

import { HUNTER_API_KEY } from './config.js';

export async function fetchHunterEmail({ firstName, lastName, domain }) {
    if (!firstName || !lastName || !domain) {
        return { ok: false, error: 'missing-params', email: null, raw: null };
    }
    const qs = new URLSearchParams({
        domain,
        first_name: firstName,
        last_name: lastName,
        api_key: HUNTER_API_KEY
    });

    console.log('[Hunter] Fetching email for:', { firstName, lastName, domain });

    try {
        const res = await fetch(`https://api.hunter.io/v2/email-finder?${qs.toString()}`);
        if (!res.ok) {
            const details = await res.text().catch(() => '');
            return { ok: false, error: `hunter-${res.status}`, details, email: null, raw: null };
        }
        const payload = await res.json().catch(() => null);
        const email = payload?.data?.email || payload?.data?.result || null;
        const score = payload?.data?.score ?? payload?.data?.confidence_score ?? null;
        console.log('[Hunter] API response:', JSON.stringify(payload, null, 2));
        return { ok: true, email, score, raw: payload };
    } catch (err) {
        console.warn('[Specter-Outreach] Hunter email lookup failed:', err);
        return { ok: false, error: err.message, email: null, raw: null };
    }
}

export async function enrichFounderContact(payload) {
    try {
        const firstName = String(payload?.firstName || '').trim();
        const lastName = String(payload?.lastName || '').trim();
        const domain = String(payload?.domain || '').trim() || null;
        const existingLinkedIn = String(payload?.existingLinkedIn || '').trim() || null;

        if (!firstName || !lastName) {
            return { ok: false, error: 'missing-name' };
        }

        const hunter = domain
            ? await fetchHunterEmail({ firstName, lastName, domain })
            : { ok: false, error: 'missing-domain', email: null };

        const linkedinUrl = existingLinkedIn || hunter?.raw?.data?.linkedin_url || null;
        const email = hunter?.email || null;

        return {
            ok: true,
            linkedinUrl,
            email,
            debug: {
                hunter
            }
        };
    } catch (err) {
        console.warn('[Specter-Outreach] enrichFounderContact error:', err);
        return { ok: false, error: err.message };
    }
}
