// background-scripts/config.js

export const CLIENT_ID = process.env.CLIENT_ID;

export const SCOPES = [
    'openid',
    'profile',
    'offline_access',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/User.Read'
].join(' ');

export const AFFINITY_REQUEST_TIMEOUT_MS = 50000;

export const LANGFUSE_HOST = process.env.LANGFUSE_HOST;
export const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
export const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
export const SUPABASE_FUNCTION_BASE_URL = process.env.SUPABASE_FUNCTION_BASE_URL;
export const SUPABASE_EDGE_FUNCTION_URL = `${SUPABASE_FUNCTION_BASE_URL}/outreach`;

export const SUPABASE_FUNCTION_HEADERS = Object.freeze({
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    apikey: SUPABASE_ANON_KEY
});

export const SUPABASE_LOG_BODY_PREVIEW_LIMIT = 1024;

export const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
export const UNIPILE_API_URL = process.env.UNIPILE_API_URL;
export const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;

export const PARALLEL_API_BASE_URL = process.env.PARALLEL_API_BASE_URL;
export const PARALLEL_API_KEY = process.env.PARALLEL_API_KEY;
export const PARALLEL_POLL_INTERVAL_MS = 4000;
export const PARALLEL_MAX_WAIT_MS = 180000;

export const NOTION_API_KEY = process.env.NOTION_API_KEY;
export const NOTION_VERSION = '2022-06-28';
export const NOTION_DIRECTORY_PAGE_ID = process.env.NOTION_DIRECTORY_PAGE_ID;

export const AFFINITY_API_BASE_URL = process.env.AFFINITY_API_BASE_URL;
export const AFFINITY_API_KEY = process.env.AFFINITY_API_KEY;

export const LINKEDIN_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
export const LINKEDIN_CHAT_CACHE_TTL_MS = 5 * 60 * 1000;

// Additional config from extension
export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export const UNIPILE_POLL_INTERVAL_MS = 5000;
