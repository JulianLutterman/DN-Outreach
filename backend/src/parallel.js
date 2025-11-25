// background-scripts/parallel.js

import { PARALLEL_API_BASE_URL, PARALLEL_API_KEY, PARALLEL_POLL_INTERVAL_MS, PARALLEL_MAX_WAIT_MS } from './config.js';
import { sleep } from './utils.js';

export async function startParallelFounderTask({ websiteLink }) {
    const website = String(websiteLink || '').trim();
    if (!website) {
        return { ok: false, error: 'missing-website' };
    }

    const body = {
        input: { website_link: website },
        processor: 'lite',
        task_spec: {
            input_schema: {
                json_schema: {
                    type: 'object',
                    properties: {
                        website_link: {
                            description: 'The website URL of the startup company.',
                            type: 'string'
                        }
                    },
                    required: ['website_link']
                },
                type: 'json'
            },
            output_schema: {
                json_schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        first_last_name: {
                            description: "The full name of the CEO/Founder or most important person in the company. The name should be in 'First Name Last Name' format.",
                            type: 'string'
                        },
                        linkedin_profile: {
                            description: "The LinkedIn profile URL of the CEO/Founder or most important person.",
                            type: 'string'
                        },
                        relevant_experience: {
                            description: "A summary of the person's most important previous professional experience that is specifically relevant to the target startup company.",
                            type: 'string'
                        }
                    },
                    required: ['first_last_name', 'linkedin_profile', 'relevant_experience']
                },
                type: 'json'
            }
        }
    };

    try {
        const res = await fetch(`${PARALLEL_API_BASE_URL}/tasks/runs`, {
            method: 'POST',
            headers: {
                'x-api-key': PARALLEL_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const details = await res.text().catch(() => '');
            return { ok: false, error: `parallel-${res.status}`, details };
        }

        const payload = await res.json().catch(() => null);
        const runId = payload?.run_id || payload?.runId || null;
        const status = payload?.status || payload?.run?.status || 'queued';

        if (!runId) {
            return { ok: false, error: 'missing-run-id', details: payload };
        }

        return { ok: true, runId, status, raw: payload };
    } catch (err) {
        console.warn('[Specter-Outreach] Parallel task creation failed:', err);
        return { ok: false, error: err?.message || 'parallel-create-failed' };
    }
}

export async function fetchParallelRunResult(runId) {
    if (!runId) {
        return { ok: false, error: 'missing-run-id' };
    }

    try {
        const res = await fetch(`${PARALLEL_API_BASE_URL}/tasks/runs/${runId}/result`, {
            method: 'GET',
            headers: {
                'x-api-key': PARALLEL_API_KEY
            }
        });

        const payload = await res.json().catch(() => null);
        if (!res.ok) {
            const status = payload?.run?.status || null;
            return { ok: false, error: `parallel-${res.status}`, status, raw: payload };
        }

        const status = payload?.run?.status || null;
        const output = payload?.output?.content || null;
        return { ok: true, status, output, raw: payload };
    } catch (err) {
        console.warn('[Specter-Outreach] Parallel task polling failed:', err);
        return { ok: false, error: err?.message || 'parallel-poll-failed' };
    }
}

export async function waitForParallelFounderResult({ runId, pollIntervalMs = PARALLEL_POLL_INTERVAL_MS, timeoutMs = PARALLEL_MAX_WAIT_MS } = {}) {
    if (!runId) {
        return { ok: false, error: 'missing-run-id' };
    }

    const start = Date.now();
    let lastStatus = 'queued';

    while (Date.now() - start < timeoutMs) {
        const res = await fetchParallelRunResult(runId);

        if (!res.ok) {
            if (res.status && ['failed', 'cancelled', 'canceled'].includes(res.status)) {
                return { ok: false, error: `parallel-${res.status}`, raw: res.raw };
            }
        } else {
            lastStatus = res.status || lastStatus;
            if (res.status === 'completed') {
                return { ok: true, runId, data: res.output, raw: res.raw };
            }
            if (res.status && ['failed', 'cancelled', 'canceled'].includes(res.status)) {
                return { ok: false, error: `parallel-${res.status}`, raw: res.raw };
            }
        }

        await sleep(pollIntervalMs);
    }

    return { ok: false, error: 'parallel-timeout', status: lastStatus };
}
