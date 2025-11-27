import { startParallelFounderTask, waitForParallelFounderResult } from '../parallel.js';

export const handleStartParallelTask = async (req, res) => {
    try {
        const result = await startParallelFounderTask(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleGetParallelResult = async (req, res) => {
    try {
        const result = await waitForParallelFounderResult(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
