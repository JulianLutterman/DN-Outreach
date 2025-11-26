// backend/src/email-generation.js

import { generateEmailViaLLM } from './llm.js';
import { crawlWebsite } from './firecrawl.js';
import {
    startParallelFounderTask,
    waitForParallelFounderResult
} from './parallel.js';
import { enrichFounderContact } from './hunter.js';
import {
    resolveContentPageIdsForUser,
    fetchNotionPageContent
} from './notion.js';
import {
    escapeRegExp,
    splitFullName,
    ensureHttpUrl,
    extractDomainFromUrl
} from './utils.js';

export async function generateCompleteEmail(payload, onProgress = () => { }) {
    const {
        companyContext,
        calendlyLink = '',
        userInfo = {},
        modelId = 'deepseek/deepseek-v3.1-terminus'
    } = payload;

    const result = {
        ok: false,
        subject: '',
        body: '',
        founderContact: null,
        error: null
    };

    try {
        // Step 1: Start Parallel founder task
        onProgress('Starting Parallel founder task...');
        console.log('[Email Generation] Starting Parallel founder task for:', companyContext.website);
        const parallelStartResult = await startParallelFounderTask({ websiteLink: companyContext.website });

        if (!parallelStartResult.ok) {
            result.error = 'Parallel task failed: ' + (parallelStartResult.error || 'unknown');
            return result;
        }

        const runId = parallelStartResult.runId;

        // Step 2: Fetch Notion content and Firecrawl in parallel
        onProgress('Fetching Notion templates & crawling site...');
        console.log('[Email Generation] Fetching Notion and Firecrawl in parallel');
        const [notionResult, crawlResult] = await Promise.allSettled([
            (async () => {
                const pageIds = await resolveContentPageIdsForUser(userInfo);
                const [taskDescription, portfolio, exampleEmails] = await Promise.all([
                    fetchNotionPageContent(pageIds.taskDescriptionId),
                    fetchNotionPageContent(pageIds.portfolioId),
                    fetchNotionPageContent(pageIds.exampleEmailsId)
                ]);
                return { taskDescription, portfolio, exampleEmails };
            })(),
            crawlWebsite(companyContext.website)
        ]);

        if (notionResult.status !== 'fulfilled') {
            result.error = 'Notion fetch failed: ' + (notionResult.reason?.message || notionResult.reason);
            return result;
        }

        const notionContent = notionResult.value;
        const crawlData = crawlResult.status === 'fulfilled' && crawlResult.value?.ok
            ? crawlResult.value.data
            : null;

        // Step 3: Wait for Parallel founder result
        onProgress('Waiting for founder data...');
        console.log('[Email Generation] Waiting for Parallel founder result');
        const parallelResult = await waitForParallelFounderResult({ runId });

        if (!parallelResult.ok) {
            result.error = 'Parallel task did not complete: ' + (parallelResult.error || 'unknown');
            return result;
        }

        let founderOutput = parallelResult.data || {};
        if (typeof founderOutput === 'string') {
            try {
                founderOutput = JSON.parse(founderOutput);
            } catch (e) {
                console.warn('[Email Generation] Failed to parse Parallel output:', e);
                founderOutput = {};
            }
        }

        console.log('[Email Generation] Parallel founder output:', JSON.stringify(founderOutput, null, 2));

        const founderName = String(founderOutput?.first_last_name || '').trim();
        const linkedinLink = (founderOutput?.linkedin_profile || '').trim();
        const relevantExperience = String(founderOutput?.relevant_experience || '').trim();

        const { firstName, lastName } = splitFullName(founderName);

        // Step 4: Enrich founder email with Hunter
        let enrichedEmail = '';
        const domain = companyContext.domain || extractDomainFromUrl(companyContext.website || '');

        if (firstName && lastName && domain) {
            onProgress('Enriching contact details...');
            console.log('[Email Generation] Enriching founder contact with Hunter');
            const hunterResult = await enrichFounderContact({
                firstName,
                lastName,
                companyName: companyContext.companyName || '',
                domain,
                existingLinkedIn: linkedinLink || ''
            });

            if (hunterResult.ok && hunterResult.email) {
                enrichedEmail = hunterResult.email;
            }
            console.log('[Email Generation] Hunter result:', JSON.stringify(hunterResult, null, 2));
        }

        // Update company context with founder info
        const enrichedCompanyContext = {
            ...companyContext,
            founder: {
                fullName: founderName,
                firstName,
                lastName,
                linkedin: linkedinLink,
                relevantExperience
            }
        };

        result.founderContact = {
            fullName: founderName,
            firstName,
            lastName,
            email: enrichedEmail || '',
            linkedin: linkedinLink ? ensureHttpUrl(linkedinLink) : '',
            domain: domain || '',
            relevantExperience
        };

        console.log('[Email Generation] Final founder contact:', JSON.stringify(result.founderContact, null, 2));

        // Step 5: Build system prompt from Notion content
        const { taskDescription, portfolio, exampleEmails } = notionContent;
        const userInfoForPrompt = {
            firstName: userInfo.firstName || '[Your First Name]',
            lastName: userInfo.lastName || '[Your Last Name]'
        };

        const finalTaskDescription = taskDescription
            .replace(/\$\{userInfo\.firstName\s*\|\|\s*'\[Your First Name\]'\}/g, userInfoForPrompt.firstName)
            .replace(/\$\{userInfo\.lastName\s*\|\|\s*'\[Your Last Name\]'\}/g, userInfoForPrompt.lastName);

        const systemPromptLines = [
            '',
            '        You are an expert VC associate working at DN Capital writing a personalized, concise, and friendly cold-outreach email (max 150 words) to a company\'s CEO. NEVER use the em-dash "-" in your email, using the em-dash "-" is forbidden! You will receive more information on the specific company from the user, and you should follow these instructions:',
            '',
            '        ' + finalTaskDescription,
            '',
            "        When drafting the message, explicitly weave in the founder's most relevant prior experiences provided in the context to show nuanced understanding.",
            '',
            '        **Format your entire response like this, with no other text before or after:**',
            '',
            '        Subject: [Your generated subject line here]',
            '',
            '        [Your generated email body here, starting with "Hi [First Name]," or similar]',
            '',
            '        Also, here is some reference information on our portcos, as well as example cold emails (you need to replicate the writing style and structure in your output emails, although you can do the customizations more thorough/deep than in the examples):',
            '',
            '        ' + portfolio,
            '',
            '        ' + exampleEmails,
            '    ',
        ];
        const systemPrompt = systemPromptLines.join('\n');

        // Step 6: Generate email via LLM
        onProgress('Drafting email via LLM...');
        console.log('[Email Generation] Generating email via LLM');
        const llmResult = await generateEmailViaLLM({
            companyContext: enrichedCompanyContext,
            crawlData,
            calendlyLink,
            userInfo,
            systemPrompt,
            modelId
        });

        if (!llmResult.ok) {
            result.error = 'LLM generation failed: ' + (llmResult.error || 'unknown');
            return result;
        }

        const fullResponse = llmResult.content;

        // Step 7: Parse response and process Calendly links
        const subjectMatch = fullResponse.match(/^Subject: (.*)/);
        const subject = subjectMatch ? subjectMatch[1] : 'Following up';
        let body = fullResponse.replace(/^Subject: .*\n\n?/, '');

        if (calendlyLink) {
            const url = calendlyLink.match(/^https?:\/\//i) ? calendlyLink : `https://${calendlyLink}`;
            const anchor = `<a href="${url}">here is my Calendly</a>`;
            const cleanCalendly = calendlyLink.replace(/^https?:\/\//i, '');
            const regex = new RegExp(`(here\\s+is\\s+my\\s+Calendly[:\\s]*)?(https?:\\/\\/)?${escapeRegExp(cleanCalendly)}`, 'gi');
            body = body.replace(regex, anchor);
        }

        result.ok = true;
        result.subject = subject;
        result.body = body;

        return result;

    } catch (error) {
        console.error('[Email Generation] Error:', error);
        result.error = error.message || 'Unknown error during email generation';
        return result;
    }
}
