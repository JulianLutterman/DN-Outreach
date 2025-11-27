import {
    fetchSupabasePartners,
    fetchWorkflowSnapshot,
    deleteSupabaseTask,
    insertTaskRecords,
    insertCompanyRecord
} from '../supabase.js';
import { processOverdueTasks } from '../tasks.js';

export const handleGetPartners = async (req, res) => {
    try {
        const partners = await fetchSupabasePartners();
        res.json({ ok: true, partners });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleGetWorkflowSnapshot = async (req, res) => {
    try {
        const snapshot = await fetchWorkflowSnapshot(req.body || {});
        res.json(snapshot);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleDeleteTask = async (req, res) => {
    try {
        const taskId = req.body?.taskId || req.body?.id;
        if (!taskId) return res.status(400).json({ ok: false, error: 'task-id-missing' });
        const ok = await deleteSupabaseTask(taskId);
        res.json({ ok: !!ok, error: ok ? undefined : 'delete-failed' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleProcessOverdueTasks = async (req, res) => {
    try {
        const summary = await processOverdueTasks(req.body || {});
        res.json({ ok: true, summary });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleUpsertTasks = async (req, res) => {
    try {
        const result = await insertTaskRecords(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleUpsertCompany = async (req, res) => {
    try {
        const result = await insertCompanyRecord(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
