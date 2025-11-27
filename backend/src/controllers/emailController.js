import { generateCompleteEmail } from '../email-generation.js';

export const handleGenerateCompleteEmail = async (req, res) => {
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
};
