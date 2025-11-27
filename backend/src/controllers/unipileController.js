import {
    createUnipileLinkedInLink,
    checkUnipileLinkedInAccount,
    syncUnipileStatus,
    updateUserUnipileId
} from '../unipile.js';

export const handleGenerateLogin = async (req, res) => {
    try {
        const result = await createUnipileLinkedInLink(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleCheckAccount = async (req, res) => {
    try {
        const result = await checkUnipileLinkedInAccount(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleSyncStatus = async (req, res) => {
    try {
        const result = await syncUnipileStatus(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};

export const handleUpsertUser = async (req, res) => {
    try {
        const result = await updateUserUnipileId(req.body || {});
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
