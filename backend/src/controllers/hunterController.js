import { enrichFounderContact } from '../hunter.js';

export const handleEnrichFounder = async (req, res) => {
    try {
        const result = await enrichFounderContact(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
