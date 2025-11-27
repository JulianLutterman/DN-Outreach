import { getWidgetHTML, getUIConfig } from '../ui-templates.js';

export const handleGetWidgetHTML = (req, res) => {
    try {
        const html = getWidgetHTML();
        res.json({ ok: true, html });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleGetUIConfig = (req, res) => {
    try {
        const config = getUIConfig();
        res.json({ ok: true, config });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
