import express from 'express';
import cors from 'cors';
import {
    fetchSupabasePartners,
    ensureSupabaseUser,
    insertTaskRecords,
    fetchWorkflowSnapshot,
    deleteSupabaseTask,
    insertCompanyRecord,
    fetchCompanyByDomainOrName,
    fetchCompanyTasks,
    fetchCompanyById,
    fetchOutstandingTasks,
    fetchOverdueTasks,
    fetchUpcomingTasksForUser
} from '../src/supabase.js';
import {
    resolveContentPageIdsForUser,
    fetchNotionPageContent
} from '../src/notion.js';
import { processOverdueTasks } from '../src/tasks.js';
import { enrichFounderContact } from '../src/hunter.js';
import {
    createUnipileLinkedInLink,
    checkUnipileLinkedInAccount,
    syncUnipileStatus,
    updateUserUnipileId
} from '../src/unipile.js';
import {
    startParallelFounderTask,
    waitForParallelFounderResult
} from '../src/parallel.js';
import {
    getDealPipelineStatus,
    addOrganizationToDealPipeline
} from '../src/affinity.js';
import { langfuseIngest } from '../src/langfuse.js';
import {
    getWidgetHTML,
    getUIConfig
} from '../src/ui-templates.js';
import { generateEmailViaLLM } from '../src/llm.js';
import { crawlWebsite } from '../src/firecrawl.js';
import { generateCompleteEmail } from '../src/email-generation.js';

const app = express();

// Allow all origins for now (extension usage)
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
    res.send('DNOutreach Backend is running. This is an API server, not a website.');
});

// --- UI Templates ---

app.post('/api/ui/widget-html', (req, res) => {
    try {
        const html = getWidgetHTML();
        res.json({ ok: true, html });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/ui/config', (req, res) => {
    try {
        const config = getUIConfig();
        res.json({ ok: true, config });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- LLM ---

app.post('/api/llm/generate-email', async (req, res) => {
    try {
        const result = await generateEmailViaLLM(req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Firecrawl ---

app.post('/api/firecrawl/crawl', async (req, res) => {
    try {
        const { url } = req.body;
        const result = await crawlWebsite(url);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Email Generation ---

app.post('/api/email/generate-complete', async (req, res) => {
    try {
        // Set headers for SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const onProgress = (message) => {
            res.write(`data: ${JSON.stringify({ type: 'progress', message })}\n\n`);
        };

        const result = await generateCompleteEmail(req.body, onProgress);

        // Send final result
        res.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
        res.end();
    } catch (err) {
        // If headers are already sent, we must send error as event
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ ok: false, error: err.message });
        }
    }
});

// --- Supabase ---

app.post('/api/partners', async (req, res) => {
    try {
        const partners = await fetchSupabasePartners();
        res.json({ ok: true, partners });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/workflow/snapshot', async (req, res) => {
    try {
        const snapshot = await fetchWorkflowSnapshot(req.body || {});
        res.json(snapshot);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/tasks/delete', async (req, res) => {
    try {
        const taskId = req.body?.taskId || req.body?.id;
        if (!taskId) return res.status(400).json({ ok: false, error: 'task-id-missing' });
        const ok = await deleteSupabaseTask(taskId);
        res.json({ ok: !!ok, error: ok ? undefined : 'delete-failed' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/tasks/overdue', async (req, res) => {
    try {
        const summary = await processOverdueTasks(req.body || {});
        res.json({ ok: true, summary });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/tasks/upsert', async (req, res) => {
    try {
        const result = await insertTaskRecords(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/company/upsert', async (req, res) => {
    try {
        const result = await insertCompanyRecord(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Notion ---

app.post('/api/notion/content', async (req, res) => {
    try {
        const userInfo = req.body?.userInfo || {};
        const {
            taskDescriptionId,
            portfolioId,
            exampleEmailsId
        } = await resolveContentPageIdsForUser(userInfo);

        const [taskDescription, portfolio, exampleEmails] = await Promise.all([
            fetchNotionPageContent(taskDescriptionId),
            fetchNotionPageContent(portfolioId),
            fetchNotionPageContent(exampleEmailsId)
        ]);

        res.json({
            ok: true,
            data: { taskDescription, portfolio, exampleEmails }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Hunter ---

app.post('/api/hunter/enrich', async (req, res) => {
    try {
        const result = await enrichFounderContact(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Unipile ---

app.post('/api/unipile/generate-login', async (req, res) => {
    try {
        const result = await createUnipileLinkedInLink(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/unipile/check-account', async (req, res) => {
    try {
        const result = await checkUnipileLinkedInAccount(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/unipile/sync-status', async (req, res) => {
    try {
        const result = await syncUnipileStatus(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/unipile/upsert-user', async (req, res) => {
    try {
        const result = await updateUserUnipileId(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Parallel ---

app.post('/api/parallel/start', async (req, res) => {
    try {
        const result = await startParallelFounderTask(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/parallel/result', async (req, res) => {
    try {
        const result = await waitForParallelFounderResult(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Affinity ---

app.post('/api/affinity/status', async (req, res) => {
    try {
        const data = await getDealPipelineStatus(req.body || {});
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/affinity/add', async (req, res) => {
    try {
        const data = await addOrganizationToDealPipeline(req.body || {});
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// --- Langfuse ---

app.post('/api/langfuse/log', async (req, res) => {
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

export default app;
