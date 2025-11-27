// backend/src/firecrawl.js

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function crawlWebsite(targetUrl) {
    if (!targetUrl) {
        console.log('[Firecrawl] No URL provided for crawling.');
        return { ok: false, error: 'No URL provided' };
    }

    const MAX_POLL_ATTEMPTS = 40;
    const POLL_INTERVAL_MS = 3000;

    let jobId;
    try {
        console.log('[Firecrawl] Starting website crawl job for:', targetUrl);

        const startResponse = await fetch('https://api.firecrawl.dev/v2/crawl', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + FIRECRAWL_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "url": targetUrl,
                "sitemap": "include",
                "crawlEntireDomain": false,
                "limit": 7,
                "prompt": "Info on product and rest of the company that can be used by VC to write a very customized cold email to the target company (whose website you're scraping). Always include the main/index page. Exclude ToS & other types of regulatory policy documents (privacy statements, legal disclaimers, etc.)",
                "scrapeOptions": {
                    "onlyMainContent": true,
                    "maxAge": 172800000,
                    "parsers": ["pdf"],
                    "formats": ["markdown"]
                }
            })
        });

        if (!startResponse.ok) {
            const errorText = await startResponse.text();
            throw new Error('Failed to start crawl job: ' + errorText);
        }

        const startData = await startResponse.json();
        if (!startData.id) {
            throw new Error('Crawl job ID not found in response.');
        }

        jobId = startData.id;
        console.log('[Firecrawl] Crawl job started with ID:', jobId);

    } catch (error) {
        console.error('[Firecrawl] Start error:', error);
        return { ok: false, error: error.message, status: 'failed' };
    }

    // Poll for completion
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await sleep(POLL_INTERVAL_MS);

        try {
            const statusResponse = await fetch('https://api.firecrawl.dev/v2/crawl/' + jobId, {
                headers: { 'Authorization': 'Bearer ' + FIRECRAWL_API_KEY }
            });

            if (!statusResponse.ok) {
                console.warn('[Firecrawl] Polling failed (attempt ' + (i + 1) + '): Status ' + statusResponse.status);
                continue;
            }

            const statusData = await statusResponse.json();
            const { status, completed = 0, total = '?', data } = statusData;

            console.log(`[Firecrawl] Status: ${status}, Progress: ${completed}/${total}`);

            if (status === 'completed') {
                console.log('[Firecrawl] Website crawl successful.');
                if (data && Array.isArray(data)) {
                    const crawlData = data
                        .map(page => 'Source URL: ' + (page.metadata?.sourceURL || '') + '\n\n' + page.markdown)
                        .join('\n\n---\n\n');
                    return { ok: true, data: crawlData, status: 'completed', completed, total };
                }
                return { ok: true, data: null, status: 'completed', completed, total };
            }

            if (status === 'failed') {
                throw new Error('Firecrawl job failed.');
            }

            // Still in progress, return status for client
            if (i === MAX_POLL_ATTEMPTS - 1) {
                // Last attempt
                return { ok: false, error: 'Crawl timed out', status, completed, total };
            }

        } catch (error) {
            console.error('[Firecrawl] Poll error:', error);
            return { ok: false, error: error.message, status: 'error' };
        }
    }

    console.error('[Firecrawl] Job timed out.');
    return { ok: false, error: 'Crawl timed out after 2 minutes', status: 'timeout' };
}

