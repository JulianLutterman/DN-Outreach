import { getDealPipelineStatus, addOrganizationToDealPipeline } from '../affinity.js';

export const handleGetAffinityStatus = async (req, res) => {
    try {
        const data = await getDealPipelineStatus(req.body || {});
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleAddAffinity = async (req, res) => {
    try {
        const data = await addOrganizationToDealPipeline(req.body || {});
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
