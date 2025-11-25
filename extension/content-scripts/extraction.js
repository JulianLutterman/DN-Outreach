// content-scripts/extraction.js

import { ensureHttpUrl, extractDomainFromUrl } from './utils.js';

// crawlWebsite() has been moved to backend - use chrome.runtime.sendMessage with type 'CRAWL_WEBSITE'

export function gatherCompanyContextFromPage(existing = window.__companyContext || {}) {
    const previousContext = existing || {};
    const currentHref = typeof location?.href === 'string' ? location.href : '';
    const currentHostname = typeof location?.hostname === 'string' ? location.hostname : '';
    const pageDomain = extractDomainFromUrl(currentHostname || currentHref || '');
    const shouldReset = previousContext?.domain && pageDomain && previousContext.domain !== pageDomain;
    const context = shouldReset ? {} : { ...previousContext };

    if (pageDomain) {
        context.domain = pageDomain;
    } else {
        delete context.domain;
    }

    const origin = typeof location?.origin === 'string' ? location.origin : '';
    const normalizedOrigin = origin || (pageDomain ? 'https://' + pageDomain : '');
    if (normalizedOrigin) {
        context.website = normalizedOrigin;
    } else if (!context.website) {
        context.website = '';
    }

    const pushCandidate = (list, value) => {
        if (!value || typeof value !== 'string') return;
        const trimmed = value.trim();
        if (!trimmed) return;
        if (!list.includes(trimmed)) {
            list.push(trimmed);
        }
    };

    const nextData = window.__NEXT_DATA__ || window.__APOLLO_STATE__ || null;
    const nextCandidates = [];
    if (nextData?.props?.pageProps) {
        const props = nextData.props.pageProps;
        pushCandidate(nextCandidates, props?.company?.name);
        pushCandidate(nextCandidates, props?.company?.legal_name);
        pushCandidate(nextCandidates, props?.company?.company_name);
        pushCandidate(nextCandidates, props?.profile?.company?.name);
        pushCandidate(nextCandidates, props?.data?.company?.name);
        pushCandidate(nextCandidates, props?.entity?.name);
    }

    const candidateNames = [];
    nextCandidates.forEach(name => pushCandidate(candidateNames, name));

    if (document.body?.dataset) {
        pushCandidate(candidateNames, document.body.dataset.companyName);
        pushCandidate(candidateNames, document.body.dataset.company);
    }

    const ogTitle = document.querySelector('meta[property="og:title"], meta[name="og:title"]')?.content;
    if (ogTitle) {
        const first = ogTitle.split(/\||\u2013|-|\u2014/)[0];
        pushCandidate(candidateNames, first);
    }

    const pageTitle = document.title || '';
    if (pageTitle) {
        const first = pageTitle.split(/\||\u2013|-|\u2014/)[0];
        pushCandidate(candidateNames, first);
    }

    const h1 = document.querySelector('main h1, h1');
    if (h1?.textContent) {
        pushCandidate(candidateNames, h1.textContent);
    }

    if (!context.companyName) {
        const chosen = candidateNames.find(name => name.length > 1 && name.length <= 160);
        if (chosen) context.companyName = chosen.trim();
    }

    const websiteCandidates = [];
    const collectWebsiteFrom = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        pushCandidate(websiteCandidates, obj.website);
        pushCandidate(websiteCandidates, obj.website_url);
        pushCandidate(websiteCandidates, obj.websiteUrl);
        pushCandidate(websiteCandidates, obj.url);
        pushCandidate(websiteCandidates, obj.homepage);
        pushCandidate(websiteCandidates, obj.domain);
    };

    if (nextData?.props?.pageProps?.company) collectWebsiteFrom(nextData.props.pageProps.company);
    if (nextData?.props?.pageProps?.profile?.company) collectWebsiteFrom(nextData.props.pageProps.profile.company);
    if (nextData?.props?.pageProps?.data?.company) collectWebsiteFrom(nextData.props.pageProps.data.company);

    if (document.body?.dataset?.website) pushCandidate(websiteCandidates, document.body.dataset.website);

    const findWebsiteFromAnchors = () => {
        const anchors = Array.from(document.querySelectorAll('a[href^="http"]'));
        const host = (location.hostname || '').replace(/^www\./, '').toLowerCase();
        const socialDomains = ['linkedin.com', 'www.linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com', 'medium.com', 'github.com', 'tiktok.com', 'angel.co', 'crunchbase.com'];
        const priority = [];
        const fallback = [];

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (!href) continue;
            let parsed;
            try {
                parsed = new URL(href, location.origin);
            } catch (_) {
                continue;
            }
            const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();
            if (!domain || domain === host) continue;
            if (socialDomains.some(social => domain.endsWith(social))) continue;

            const candidate = ensureHttpUrl(parsed.href);
            const text = (anchor.textContent || '').trim();
            if (/website|visit|launch|product|app/i.test(text)) {
                if (!priority.includes(candidate)) priority.push(candidate);
            } else {
                if (!fallback.includes(candidate)) fallback.push(candidate);
            }
        }

        return priority[0] || fallback[0] || '';
    };

    const anchorWebsite = findWebsiteFromAnchors();
    if (anchorWebsite) pushCandidate(websiteCandidates, anchorWebsite);

    if (!context.website) {
        const chosenWebsite = websiteCandidates.find(Boolean);
        if (chosenWebsite) {
            context.website = ensureHttpUrl(chosenWebsite);
        }
    }

    if (!context.domain && context.website) {
        context.domain = extractDomainFromUrl(context.website);
    }

    if (!context.domain && websiteCandidates.length) {
        const candidateDomain = extractDomainFromUrl(websiteCandidates[0]);
        if (candidateDomain) context.domain = candidateDomain;
    }

    return context;
}

export function updateCompanyContextFromPage() {
    const context = gatherCompanyContextFromPage(window.__companyContext || {});
    window.__companyContext = context;
    return context;
}
