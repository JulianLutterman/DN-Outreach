import { generateEmailViaLLM } from '../llm.js';

export const handleGenerateEmail = async (req, res) => {
    try {
        const result = await generateEmailViaLLM(req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
