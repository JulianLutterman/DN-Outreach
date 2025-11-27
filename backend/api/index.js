import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { handleGetWidgetHTML, handleGetUIConfig } from '../src/controllers/uiController.js';
import { handleGenerateEmail } from '../src/controllers/llmController.js';
import { handleCrawlWebsite } from '../src/controllers/firecrawlController.js';
import { handleGenerateCompleteEmail } from '../src/controllers/emailController.js';
import {
    handleGetPartners,
    handleGetWorkflowSnapshot,
    handleDeleteTask,
    handleProcessOverdueTasks,
    handleUpsertTasks,
    handleUpsertCompany
} from '../src/controllers/supabaseController.js';
import { handleGetNotionContent } from '../src/controllers/notionController.js';
import { handleEnrichFounder } from '../src/controllers/hunterController.js';
import {
    handleGenerateLogin,
    handleCheckAccount,
    handleSyncStatus,
    handleUpsertUser
} from '../src/controllers/unipileController.js';
import { handleStartParallelTask, handleGetParallelResult } from '../src/controllers/parallelController.js';
import { handleGetAffinityStatus, handleAddAffinity } from '../src/controllers/affinityController.js';
import { handleLangfuseLog } from '../src/controllers/langfuseController.js';

const app = express();

// Allow all origins for now (extension usage)
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
    res.send('DNOutreach Backend is running. This is an API server, not a website.');
});

// --- UI Templates ---
app.post('/api/ui/widget-html', handleGetWidgetHTML);
app.post('/api/ui/config', handleGetUIConfig);

// --- LLM ---
app.post('/api/llm/generate-email', handleGenerateEmail);

// --- Firecrawl ---
app.post('/api/firecrawl/crawl', handleCrawlWebsite);

// --- Email Generation ---
app.post('/api/email/generate-complete', handleGenerateCompleteEmail);

// --- Supabase ---
app.post('/api/partners', handleGetPartners);
app.post('/api/workflow/snapshot', handleGetWorkflowSnapshot);
app.post('/api/tasks/delete', handleDeleteTask);
app.post('/api/tasks/overdue', handleProcessOverdueTasks);
app.post('/api/tasks/upsert', handleUpsertTasks);
app.post('/api/company/upsert', handleUpsertCompany);

// --- Notion ---
app.post('/api/notion/content', handleGetNotionContent);

// --- Hunter ---
app.post('/api/hunter/enrich', handleEnrichFounder);

// --- Unipile ---
app.post('/api/unipile/generate-login', handleGenerateLogin);
app.post('/api/unipile/check-account', handleCheckAccount);
app.post('/api/unipile/sync-status', handleSyncStatus);
app.post('/api/unipile/upsert-user', handleUpsertUser);

// --- Parallel ---
app.post('/api/parallel/start', handleStartParallelTask);
app.post('/api/parallel/result', handleGetParallelResult);

// --- Affinity ---
app.post('/api/affinity/status', handleGetAffinityStatus);
app.post('/api/affinity/add', handleAddAffinity);

// --- Langfuse ---
app.post('/api/langfuse/log', handleLangfuseLog);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

export default app;

