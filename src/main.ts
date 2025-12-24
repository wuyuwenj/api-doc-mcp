import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import { log, Actor } from 'apify';
import { scrapeDocs } from './scraper.js';
import { registerTools } from './tools.js';
import { getVectorDB } from './vectordb.js';

// Initialize the Apify Actor environment
await Actor.init();

// Validate required environment variables
function validateEnv() {
    const required = ['SUPABASE_URL', 'SUPABASE_KEY'];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        log.error(`Missing required environment variables: ${missing.join(', ')}`);
        log.info('Please set the following environment variables:');
        log.info('  SUPABASE_URL - Your Supabase project URL');
        log.info('  SUPABASE_KEY - Your Supabase anon or service key');
        process.exit(1);
    }
}

validateEnv();

interface ActorInput {
    startUrls?: Array<{ url: string }>;
    maxPages?: number;
    forceRefresh?: boolean;
}

// Initialize documentation on startup
async function initializeDocs() {
    log.info('Initializing documentation...');

    const input = await Actor.getInput<ActorInput>() ?? {};
    const startUrls = input.startUrls?.map((item) => item.url) ?? undefined;
    const maxPages = input.maxPages ?? undefined;
    const forceRefresh = input.forceRefresh ?? false;

    // Check if we have existing docs in the database
    const vectorDb = getVectorDB();
    const existingDocs = await vectorDb.listDocs();

    if (existingDocs.length > 0 && !forceRefresh) {
        log.info(`Found ${existingDocs.length} existing docs in database, skipping scrape`);
        log.info('Set forceRefresh: true in input to re-scrape');
        return existingDocs.length;
    }

    if (forceRefresh && existingDocs.length > 0) {
        log.info('Force refresh enabled, clearing existing data...');
        await vectorDb.clearAll();
    }

    log.info('Scraping documentation (this may take a few minutes)...');
    log.info('Scraping with configuration:', { startUrls, maxPages });

    try {
        const result = await scrapeDocs({
            startUrls,
            maxPages,
        });
        log.info(`Scraping complete: ${result.docsProcessed} docs, ${result.chunksCreated} chunks`);
        return result.docsProcessed;
    } catch (error) {
        log.error('Failed to scrape documentation:', { error });
        return 0;
    }
}

// Initialize docs before starting server
const docsCount = await initializeDocs();

const getServer = () => {
    // Create an MCP server with implementation details
    const server = new McpServer(
        {
            name: 'api-docs-mcp',
            version: '2.0.0',
        },
        { capabilities: { logging: {} } },
    );

    // Register all documentation tools
    registerTools(server);

    // Create a resource for server info
    server.registerResource(
        'server-info',
        'https://apify.com/docs-mcp/info',
        { mimeType: 'text/plain' },
        async (): Promise<ReadResourceResult> => {
            const vectorDb = getVectorDB();
            const docs = await vectorDb.listDocs();

            return {
                contents: [
                    {
                        uri: 'https://apify.com/docs-mcp/info',
                        text: `API Docs MCP Server v2.0 (RAG-enabled)

This MCP server provides semantic search access to documentation using RAG (Retrieval-Augmented Generation).

Available tools:
- list_docs: List all documentation with metadata
- search: Semantic search across all docs (main entry point)
- get_doc_overview: Get document summary and sections
- get_section: Get specific section content
- get_chunks: Paginated chunk access
- search_in_doc: Search within a specific document

Documentation loaded: ${docs.length} documents
Backend: Supabase pgvector`,
                    },
                ],
            };
        },
    );

    return server;
};

const app = express();
app.use(express.json());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
    }),
);

// Readiness probe and status endpoint
app.get('/', async (req: Request, res: Response) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
        log.info('Readiness probe');
        res.end('ok\n');
        return;
    }

    // Build the MCP endpoint URL from container web server URL
    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL;

    // Use the container web server URL, fallback to hardcoded URL
    const mcpUrl = webServerUrl
        ? `${webServerUrl}/mcp`
        : 'https://wuyuwen0--apify-api-doc-actor.apify.actor/mcp';

    // Generate the Claude CLI command
    const cliCommand = `claude mcp add --transport http api-docs ${mcpUrl} --header "Authorization: Bearer YOUR_APIFY_TOKEN"`;

    // Get doc count from database
    const vectorDb = getVectorDB();
    const docs = await vectorDb.listDocs();

    // Return server status for regular GET requests
    res.json({
        status: 'running',
        name: 'api-docs-mcp',
        version: '2.0.0',
        docs_loaded: docs.length,
        features: {
            semantic_search: true,
            chunking: 'recursive',
            embeddings: 'openrouter/text-embedding-3-small',
            vector_db: 'supabase-pgvector',
        },
        tools: ['list_docs', 'search', 'get_doc_overview', 'get_section', 'get_chunks', 'search_in_doc'],
        mcp_endpoint: mcpUrl,
        cli_command: cliCommand,
        setup_instructions: {
            step1: 'Get your Apify API token from https://console.apify.com/account/integrations',
            step2: 'Copy and run the command above, replacing YOUR_APIFY_TOKEN with your actual token',
            step3: 'Restart Claude Code to load the new MCP server',
        },
    });
});

app.post('/mcp', async (req: Request, res: Response) => {
    const server = getServer();
    try {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
            log.info('Request closed');
            transport.close();
            server.close();
        });
    } catch (error) {
        log.error('Error handling MCP request:', { error });
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error',
                },
                id: null,
            });
        }
    }
});

app.get('/mcp', (_req: Request, res: Response) => {
    log.info('Received GET MCP request');
    res.writeHead(405).end(
        JSON.stringify({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Method not allowed.',
            },
            id: null,
        }),
    );
});

app.delete('/mcp', (_req: Request, res: Response) => {
    log.info('Received DELETE MCP request');
    res.writeHead(405).end(
        JSON.stringify({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Method not allowed.',
            },
            id: null,
        }),
    );
});

// Endpoint to refresh documentation cache
app.post('/refresh-docs', async (_req: Request, res: Response) => {
    log.info('Refreshing documentation...');
    try {
        const input = await Actor.getInput<ActorInput>() ?? {};
        const startUrls = input.startUrls?.map((item) => item.url) ?? undefined;
        const maxPages = input.maxPages ?? undefined;

        log.info('Refreshing with configuration:', { startUrls, maxPages });

        // Clear existing data
        const vectorDb = getVectorDB();
        await vectorDb.clearAll();

        // Re-scrape
        const result = await scrapeDocs({
            startUrls,
            maxPages,
        });

        res.json({
            success: true,
            docs_processed: result.docsProcessed,
            chunks_created: result.chunksCreated,
        });
    } catch (error) {
        log.error('Failed to refresh docs:', { error });
        res.status(500).json({ success: false, error: 'Failed to refresh documentation' });
    }
});

// Endpoint to get stats
app.get('/stats', async (_req: Request, res: Response) => {
    try {
        const vectorDb = getVectorDB();
        const docs = await vectorDb.listDocs();

        const totalChunks = docs.reduce((sum, d) => sum + d.total_chunks, 0);

        res.json({
            total_docs: docs.length,
            total_chunks: totalChunks,
            docs_by_type: {
                api: docs.filter((d) => d.type === 'api').length,
                guide: docs.filter((d) => d.type === 'guide').length,
                example: docs.filter((d) => d.type === 'example').length,
            },
        });
    } catch (error) {
        log.error('Failed to get stats:', { error });
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Start the server
const PORT = process.env.ACTOR_WEB_SERVER_PORT ? parseInt(process.env.ACTOR_WEB_SERVER_PORT) : 3000;
app.listen(PORT, (error) => {
    if (error) {
        log.error('Failed to start server:', { error });
        process.exit(1);
    }
    log.info(`MCP Server listening on port ${PORT}`);
    log.info(`Documentation pages loaded: ${docsCount}`);

    // Output the CLI command for easy setup
    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL;
    const mcpUrl = webServerUrl
        ? `${webServerUrl}/mcp`
        : 'https://wuyuwen0--apify-api-doc-actor.apify.actor/mcp';
    const cliCommand = `claude mcp add --transport http api-docs ${mcpUrl} --header "Authorization: Bearer YOUR_APIFY_TOKEN"`;

    log.info('='.repeat(80));
    log.info('To add this MCP server to Claude Code, run:');
    log.info(cliCommand);
    log.info('Replace YOUR_APIFY_TOKEN with your token from: https://console.apify.com/account/integrations');
    log.info('='.repeat(80));
});

// Handle server shutdown
process.on('SIGINT', async () => {
    log.info('Shutting down server...');
    process.exit(0);
});
