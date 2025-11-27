import { crawlWebsite } from '../firecrawl.js';

export const handleCrawlWebsite = async (req, res) => {
    try {
        const { url } = req.body;
        const result = await crawlWebsite(url);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
};
