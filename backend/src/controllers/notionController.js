import { resolveContentPageIdsForUser, fetchNotionPageContent } from '../notion.js';

export const handleGetNotionContent = async (req, res) => {
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
};
