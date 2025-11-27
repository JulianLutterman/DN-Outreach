// background-scripts/notion.js

import { NOTION_API_KEY, NOTION_VERSION, NOTION_DIRECTORY_PAGE_ID } from './config.js';

const notionColleaguePageCache = new Map();
const notionUserContentCache = new Map();
const notionPageTitleCache = new Map();

export function sanitizeNotionId(id) {
    return (id || '').replace(/-/g, '');
}

export function extractNotionIdFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const hyphenatedMatch = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (hyphenatedMatch) {
        return sanitizeNotionId(hyphenatedMatch[1]);
    }
    const compactMatch = url.match(/([0-9a-f]{32})/i);
    if (compactMatch) {
        return compactMatch[1].toLowerCase();
    }
    return null;
}

export function normalizeLabel(str) {
    return (str || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

export async function fetchPageDirectChildren(pageId) {
    const blocks = [];
    let start_cursor = undefined;
    do {
        const url = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
        url.searchParams.append('page_size', '100');
        if (start_cursor) {
            url.searchParams.append('start_cursor', start_cursor);
        }

        const res = await fetch(url.toString(), {
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': NOTION_VERSION,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Notion API error for page ${pageId}: ${res.status} ${errorText}`);
        }

        const data = await res.json();
        blocks.push(...data.results);
        start_cursor = data.next_cursor;
    } while (start_cursor);

    return blocks;
}

export async function fetchNotionPageTitle(pageId) {
    const cleanId = sanitizeNotionId(pageId);
    if (notionPageTitleCache.has(cleanId)) {
        return notionPageTitleCache.get(cleanId);
    }

    const res = await fetch(`https://api.notion.com/v1/pages/${cleanId}`, {
        headers: {
            'Authorization': `Bearer ${NOTION_API_KEY}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json'
        }
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Failed to fetch Notion page ${cleanId}: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    let title = '';
    const properties = data.properties || {};
    for (const prop of Object.values(properties)) {
        if (prop?.type === 'title' && Array.isArray(prop.title)) {
            title = prop.title.map(t => t.plain_text).join('').trim();
            if (title) break;
        }
    }

    if (!title && data.object === 'page' && data.parent?.type === 'page_id') {
        title = data.url?.split('/')?.pop()?.replace(/[-_]/g, ' ') || '';
    }

    title = title.trim();
    notionPageTitleCache.set(cleanId, title);
    return title;
}

export function gatherPageReferences(blocks, accumulator = []) {
    for (const block of blocks || []) {
        if (!block) continue;
        const type = block.type;

        if (type === 'child_page' && block.child_page?.title) {
            accumulator.push({
                title: block.child_page.title,
                pageId: sanitizeNotionId(block.id)
            });
        }

        if (type === 'link_to_page' && block.link_to_page?.page_id) {
            accumulator.push({
                title: null,
                pageId: sanitizeNotionId(block.link_to_page.page_id)
            });
        }

        const blockPayload = block[type];
        if (blockPayload?.rich_text) {
            for (const rt of blockPayload.rich_text) {
                if (rt?.type === 'mention' && rt.mention?.page?.id) {
                    accumulator.push({
                        title: rt.plain_text?.trim() || null,
                        pageId: sanitizeNotionId(rt.mention.page.id)
                    });
                } else if (rt?.type === 'text' && rt.text?.link?.url) {
                    const inferredId = extractNotionIdFromUrl(rt.text.link.url);
                    if (inferredId) {
                        accumulator.push({
                            title: rt.plain_text?.trim() || null,
                            pageId: inferredId
                        });
                    }
                }
            }
        }

        if (type === 'bookmark' && block.bookmark?.url) {
            const inferredId = extractNotionIdFromUrl(block.bookmark.url);
            if (inferredId) {
                accumulator.push({
                    title: block.bookmark.caption?.[0]?.plain_text?.trim() || null,
                    pageId: inferredId
                });
            }
        }

        if (type === 'link_preview' && block.link_preview?.url) {
            const inferredId = extractNotionIdFromUrl(block.link_preview.url);
            if (inferredId) {
                accumulator.push({ title: null, pageId: inferredId });
            }
        }

        if (Array.isArray(block.children) && block.children.length) {
            gatherPageReferences(block.children, accumulator);
        }
    }

    return accumulator;
}

export async function findColleaguePageId(userInfo = {}) {
    const orderedCandidates = [];
    if (userInfo.displayName) orderedCandidates.push(normalizeLabel(userInfo.displayName));
    const composedName = `${userInfo.firstName || ''} ${userInfo.lastName || ''}`.trim();
    if (composedName) orderedCandidates.push(normalizeLabel(composedName));
    if (userInfo.firstName) orderedCandidates.push(normalizeLabel(userInfo.firstName));
    if (userInfo.lastName) orderedCandidates.push(normalizeLabel(userInfo.lastName));

    const candidateNames = [];
    for (const name of orderedCandidates) {
        if (name && !candidateNames.includes(name)) {
            candidateNames.push(name);
        }
    }

    for (const candidate of candidateNames) {
        if (notionColleaguePageCache.has(candidate)) {
            const cached = notionColleaguePageCache.get(candidate);
            if (cached) {
                return cached;
            }
        }
    }

    if (!candidateNames.length) {
        throw new Error('Cannot determine colleague name for Notion lookup.');
    }

    const directoryBlocks = await fetchPageDirectChildren(NOTION_DIRECTORY_PAGE_ID);
    const directoryEntries = [];

    for (const block of directoryBlocks) {
        let title = null;
        let pageId = null;
        if (block.type === 'child_page' && block.child_page?.title) {
            title = block.child_page.title;
            pageId = sanitizeNotionId(block.id);
        } else if (block.type === 'link_to_page' && block.link_to_page?.page_id) {
            pageId = sanitizeNotionId(block.link_to_page.page_id);
            try {
                title = await fetchNotionPageTitle(pageId);
            } catch (error) {
                console.warn('[Specter-Outreach] Failed to fetch linked colleague page title:', error);
            }
        }

        if (!title || !pageId) continue;
        const normalizedTitle = normalizeLabel(title);
        if (!normalizedTitle) continue;
        directoryEntries.push({ title: normalizedTitle, pageId });
        if (!notionColleaguePageCache.has(normalizedTitle)) {
            notionColleaguePageCache.set(normalizedTitle, pageId);
        }
    }

    for (const candidate of candidateNames) {
        const match = directoryEntries.find(entry => entry.title === candidate);
        if (match) {
            for (const name of candidateNames) {
                notionColleaguePageCache.set(name, match.pageId);
            }
            return match.pageId;
        }
    }

    for (const candidate of candidateNames) {
        if (candidate.length < 3) continue;
        const match = directoryEntries.find(entry =>
            entry.title.includes(candidate) || candidate.includes(entry.title)
        );
        if (match) {
            for (const name of candidateNames) {
                notionColleaguePageCache.set(name, match.pageId);
            }
            return match.pageId;
        }
    }

    for (const name of candidateNames) {
        notionColleaguePageCache.set(name, null);
    }

    throw new Error('No Notion page found for this colleague.');
}

export async function resolveContentPageIdsForUser(userInfo = {}) {
    const cacheKey = normalizeLabel(userInfo.displayName || `${userInfo.firstName || ''} ${userInfo.lastName || ''}`);
    if (cacheKey && notionUserContentCache.has(cacheKey)) {
        return notionUserContentCache.get(cacheKey);
    }

    const colleaguePageId = await findColleaguePageId(userInfo);
    const nestedBlocks = await fetchAllBlocksRecursive(colleaguePageId);
    const references = gatherPageReferences(nestedBlocks, []);

    const resolved = {
        taskDescriptionId: null,
        portfolioId: null,
        exampleEmailsId: null
    };

    const titleMap = new Map();
    for (const ref of references) {
        const cleanId = sanitizeNotionId(ref.pageId);
        if (!cleanId) continue;
        if (!ref.title) {
            try {
                ref.title = await fetchNotionPageTitle(cleanId);
            } catch (error) {
                console.warn('[Specter-Outreach] Failed to fetch title for content page', cleanId, error);
            }
        }
        if (!ref.title) continue;
        const normalized = normalizeLabel(ref.title);
        if (!titleMap.has(normalized)) {
            titleMap.set(normalized, cleanId);
        }
    }

    for (const [title, pageId] of titleMap.entries()) {
        if (!resolved.taskDescriptionId && title.includes('task description')) {
            resolved.taskDescriptionId = pageId;
        }
        if (!resolved.portfolioId && title.includes('portfolio')) {
            resolved.portfolioId = pageId;
        }
        if (!resolved.exampleEmailsId && (title.includes('example email') || title.includes('sample email'))) {
            resolved.exampleEmailsId = pageId;
        }
    }

    if (!resolved.taskDescriptionId || !resolved.portfolioId || !resolved.exampleEmailsId) {
        throw new Error('Could not resolve all Notion content pages for this colleague.');
    }

    if (cacheKey) {
        notionUserContentCache.set(cacheKey, resolved);
    }

    return resolved;
}

export async function fetchAllBlocksRecursive(blockId) {
    const allResults = [];
    let start_cursor = undefined;

    do {
        const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
        url.searchParams.append('page_size', '100');
        if (start_cursor) {
            url.searchParams.append('start_cursor', start_cursor);
        }

        const res = await fetch(url.toString(), {
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': NOTION_VERSION,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`Notion API error for block ${blockId}: ${res.status} ${errorText}`);
            return [];
        }

        const data = await res.json();

        for (const block of data.results) {
            if (block.has_children) {
                block.children = await fetchAllBlocksRecursive(block.id);
            }
        }

        allResults.push(...data.results);
        start_cursor = data.next_cursor;
    } while (start_cursor);

    return allResults;
}

export function notionBlocksToPlainText(blocks, indentLevel = 0) {
    const lines = [];
    const indent = '  '.repeat(indentLevel);

    for (const block of blocks) {
        let textContent = '';
        const type = block.type;
        if (block[type] && block[type].rich_text) {
            textContent = block[type].rich_text.map(rt => rt.plain_text).join('');
        }

        if (type === 'bulleted_list_item') {
            lines.push(`${indent}- ${textContent}`);
        } else if (textContent.trim()) {
            lines.push(`${indent}${textContent}`);
        } else {
            lines.push('');
        }

        if (block.children && block.children.length > 0) {
            lines.push(notionBlocksToPlainText(block.children, indentLevel + 1));
        }
    }
    return lines.join('\n');
}

export async function fetchNotionPageContent(pageId) {
    const nestedBlocks = await fetchAllBlocksRecursive(pageId);
    return notionBlocksToPlainText(nestedBlocks);
}
