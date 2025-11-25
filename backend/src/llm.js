// backend/src/llm.js

import { LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } from './config.js';
import { ensureHttpUrl } from './utils.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v3.1-terminus';

export function makePrompt(companyContext, crawlData, calendly, userInfo) {
    const context = companyContext || {};
    const founder = context?.founder || {};
    const userName = ((userInfo?.firstName || '') + ' ' + (userInfo?.lastName || '')).trim() || '[Your Name]';

    const companyName = (context?.companyName || '').trim() || 'Unknown Company';
    const website = (context?.website || '').trim() || 'N/A';
    const founderName = (founder?.fullName || '').trim() || 'Name unavailable';
    const founderLinkedIn = founder?.linkedin ? ensureHttpUrl(founder.linkedin) : 'LinkedIn profile unavailable.';
    const founderExperience = (founder?.relevantExperience || '').trim() || 'Relevant experience unavailable.';
    const websiteInsights = crawlData
        ? '### Website Crawl Insights (Most Important Information):\n' + crawlData
        : 'No additional website insights were gathered.';

    const promptContextLines = [
        '',
        '        ### Company Overview',
        '        - **Name:** ' + companyName,
        '        - **Website:** ' + website,
        '',
        '        ### Founder Background',
        '        - **Name:** ' + founderName,
        '        - **LinkedIn:** ' + founderLinkedIn,
        '        - **Relevant Experience:** ' + founderExperience,
        '',
        '        ' + websiteInsights,
        '',
        '        ### Your Information (The Sender)',
        '        - Your Name: ' + userName,
        '        - Your Calendly Link: ' + (calendly || 'N/A'),
        '        ',
    ];
    return promptContextLines.join('\n').trim();
}

export async function generateEmailViaLLM(payload) {
    const {
        companyContext,
        crawlData,
        calendlyLink,
        userInfo,
        systemPrompt,
        modelId
    } = payload;

    const chosenModelId = modelId || DEFAULT_MODEL_ID;
    const prompt = makePrompt(companyContext, crawlData, calendlyLink, userInfo);

    const traceId = crypto.randomUUID();
    const observationId = crypto.randomUUID();
    const start = Date.now();

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
                'HTTP-Referer': 'https://dnoutreach.vercel.app',
                'X-Title': 'DNOutreach Backend'
            },
            body: JSON.stringify({
                model: chosenModelId,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                reasoning: {
                    max_tokens: 64000,
                    exclude: true
                },
                temperature: 0.6
            })
        });

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content || '';

        if (!content) {
            throw new Error('OpenRouter returned an empty response.');
        }

        const end = Date.now();
        const latencyMs = end - start;
        const usage = data?.usage || {};
        const requestId = data?.id || null;

        // Log to Langfuse (async, don't await)
        logToLangfuse({
            traceId,
            observationId,
            modelId: chosenModelId,
            startTime: new Date(start).toISOString(),
            endTime: new Date(end).toISOString(),
            systemPrompt,
            userPrompt: prompt,
            output: content,
            usage,
            requestId,
            latencyMs,
            companyContext,
            userInfo
        }).catch(err => console.error('[LLM] Langfuse logging failed:', err));

        return {
            ok: true,
            content,
            usage,
            latencyMs
        };
    } catch (error) {
        console.error('[LLM] OpenRouter API error:', error);
        return {
            ok: false,
            error: error.message
        };
    }
}

async function logToLangfuse(logData) {
    const {
        traceId,
        observationId,
        modelId,
        startTime,
        endTime,
        systemPrompt,
        userPrompt,
        output,
        usage,
        requestId,
        latencyMs,
        companyContext,
        userInfo
    } = logData;

    const preview = (txt, n = 400) => (typeof txt === 'string' ? (txt.length > n ? txt.slice(0, n) + '...' : txt) : null);

    const body = {
        traceId,
        observationId,
        name: 'Generate outreach email',
        observationName: 'openrouter.chat.completions',
        environment: 'production',
        model: modelId,
        modelParameters: { temperature: 0.6 },
        userId: userInfo?.displayName || null,
        startTime,
        endTime,
        input: { system: systemPrompt, user: userPrompt },
        output,
        inputPreview: preview(systemPrompt + '\n\n' + userPrompt),
        outputPreview: preview(output),
        usage,
        requestId,
        latencyMs,
        companyName: companyContext?.companyName || null,
        metadata: { endpoint: 'chat.completions' }
    };

    const authString = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');

    await fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${authString}`
        },
        body: JSON.stringify({
            batch: [{
                id: observationId,
                type: 'generation-create',
                timestamp: startTime,
                body
            }],
            metadata: { sdk: 'custom-backend' }
        })
    });
}
