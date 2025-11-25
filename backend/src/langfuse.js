// background-scripts/langfuse.js

import { LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } from './config.js';

function lfAuthHeader() {
    return 'Basic ' + btoa(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`);
}

export async function langfuseIngest(batch, metadata) {
    const url = `${LANGFUSE_HOST}/api/public/ingestion`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': lfAuthHeader(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ batch, metadata })
    });
    try {
        const body = await res.json();
        console.log('[Langfuse] ingestion:', res.status, body);
    } catch (_) {
        console.log('[Langfuse] ingestion status:', res.status);
    }
}
