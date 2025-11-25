# DNOutreach Backend

This is the backend for the DNOutreach Chrome Extension. It is designed to be deployed on Vercel.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

## Local Development

1.  Start the server:
    ```bash
    node api/index.js
    ```
    The server will run on port 3000 (or `PORT` env var).

## Deployment (Vercel)

1.  Install Vercel CLI:
    ```bash
    npm i -g vercel
    ```
2.  Deploy:
    ```bash
    vercel
    ```

## Environment Variables

The following environment variables should be configured in your Vercel project settings (or `.env` for local dev). If not set, the backend will fallback to hardcoded defaults (NOT RECOMMENDED for production).

- `CLIENT_ID`: Microsoft Client ID
- `LANGFUSE_HOST`: Langfuse Host URL
- `LANGFUSE_PUBLIC_KEY`: Langfuse Public Key
- `LANGFUSE_SECRET_KEY`: Langfuse Secret Key
- `SUPABASE_URL`: Supabase URL
- `SUPABASE_ANON_KEY`: Supabase Anon Key
- `SUPABASE_FUNCTION_BASE_URL`: Supabase Edge Function Base URL
- `HUNTER_API_KEY`: Hunter.io API Key
- `UNIPILE_API_URL`: Unipile API URL
- `UNIPILE_API_KEY`: Unipile API Key
- `PARALLEL_API_BASE_URL`: Parallel AI API URL
- `PARALLEL_API_KEY`: Parallel AI API Key
- `NOTION_API_KEY`: Notion API Key
- `NOTION_DIRECTORY_PAGE_ID`: Notion Directory Page ID
- `AFFINITY_API_BASE_URL`: Affinity API URL
- `AFFINITY_API_KEY`: Affinity API Key
