import { langfuseIngest } from '../langfuse.js';

export const handleLangfuseLog = async (req, res) => {
    try {
        const p = req.body || {};
        // Logic copied from background.js
        const now = Date.now();
        const uuid = (crypto?.randomUUID?.bind(crypto) || (() => String(Math.random()).slice(2) + Date.now()))();

        const traceId = p.traceId || (crypto.randomUUID?.() || uuid());
        const genId = p.observationId || (crypto.randomUUID?.() || uuid());
        const ts = new Date(p.startTime || now).toISOString();

        const batch = [
            {
                id: crypto.randomUUID?.() || uuid(),
                timestamp: ts,
                type: 'trace-create',
                body: {
                    id: traceId,
                    timestamp: ts,
                    environment: p.environment || 'production',
                    name: p.name || 'Generate outreach email',
                    userId: p.userId || null,
                    input: p.inputPreview || null,
                    output: p.outputPreview || null,
                    tags: ['specter-outreach', 'openrouter'],
                    metadata: p.traceMetadata || {
                        pageUrl: p.pageUrl || null,
                        domain: p.domain || null
                    },
                    public: false
                }
            },
            {
                id: crypto.randomUUID?.() || uuid(),
                timestamp: ts,
                type: 'generation-create',
                body: {
                    id: genId,
                    traceId,
                    name: p.observationName || 'openrouter.chat.completions',
                    startTime: p.startTime || ts,
                    endTime: p.endTime || new Date().toISOString(),
                    completionStartTime: p.completionStartTime || p.endTime || null,
                    environment: p.environment || 'production',
                    model: p.model || null,
                    modelParameters: p.modelParameters || { temperature: p.temperature ?? 0.6 },
                    input: p.input ?? null,
                    output: p.output ?? null,
                    usage: p.usage ? {
                        promptTokens: p.usage.prompt_tokens ?? p.usage.input_tokens ?? p.usage.promptTokens ?? null,
                        completionTokens: p.usage.completion_tokens ?? p.usage.output_tokens ?? p.usage.completionTokens ?? null,
                        totalTokens: p.usage.total_tokens ?? p.usage.totalTokens ?? null
                    } : null,
                    metadata: {
                        provider: 'openrouter',
                        requestId: p.requestId || null,
                        latencyMs: p.latencyMs ?? null,
                        company: p.companyName || null,
                        calendlyProvided: !!p.calendlyProvided,
                        ...p.metadata
                    }
                }
            }
        ];

        await langfuseIngest(batch, { source: 'specter-outreach' });
        res.json({ ok: true });
    } catch (err) {
        // Log but don't fail hard?
        console.warn('[Langfuse] ingest failed:', err);
        res.json({ ok: true }); // Return ok even if logging failed
    }
};
