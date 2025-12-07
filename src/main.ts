import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import { log, Actor } from 'apify';
import { scrapeApifyDocs, DocPage } from './scraper.js';
import { registerTools } from './tools.js';

// Initialize the Apify Actor environment
await Actor.init();

// Global docs storage
let cachedDocs: DocPage[] = [];

interface ActorInput {
    startUrls?: Array<{ url: string }>;
    maxPages?: number;
}

// Initialize documentation on startup
async function initializeDocs() {
    log.info('Initializing documentation...');

    // Try to load from Key-Value Store first (cache)
    const cached = await Actor.getValue<DocPage[]>('scraped-docs');

    if (cached && cached.length > 0) {
        log.info(`Loaded ${cached.length} docs from cache`);
        cachedDocs = cached;
    } else {
        log.info('Scraping documentation (this may take a few minutes)...');
        try {
            // Read Actor input
            const input = await Actor.getInput<ActorInput>() ?? {};

            // Extract URLs from input format
            const startUrls = input.startUrls?.map((item) => item.url) ?? undefined;
            const maxPages = input.maxPages ?? undefined;

            log.info('Scraping with configuration:', { startUrls, maxPages });

            cachedDocs = await scrapeApifyDocs({
                startUrls,
                maxPages,
            });
            await Actor.setValue('scraped-docs', cachedDocs);
            log.info(`Documentation cached: ${cachedDocs.length} pages`);
        } catch (error) {
            log.error('Failed to scrape documentation:', { error });
            cachedDocs = [];
        }
    }

    log.info(`Loaded ${cachedDocs.length} documentation pages`);
}

// Initialize docs before starting server
await initializeDocs();

const getServer = () => {
    // Create an MCP server with implementation details
    const server = new McpServer(
        {
            name: 'api-docs-mcp',
            version: '1.0.0',
        },
        { capabilities: { logging: {} } },
    );

    // Register all documentation tools
    registerTools(server, cachedDocs);

    // Create a resource for server info
    server.registerResource(
        'server-info',
        'https://apify.com/docs-mcp/info',
        { mimeType: 'text/plain' },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'https://apify.com/docs-mcp/info',
                        text: `Apify Docs MCP Server\n\nThis MCP server provides access to Apify SDK documentation.\n\nAvailable tools:\n- list_available_docs: List all documentation pages\n- search_docs: Search through documentation\n- get_docs_by_id: Get full content of a specific page\n- get_api_reference: Get API reference for functions/classes\n- get_code_example: Get code examples for features\n\nDocumentation pages loaded: ${cachedDocs.length}`,
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
app.get('/', (req: Request, res: Response) => {
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

    // Return server status for regular GET requests
    res.json({
        status: 'running',
        name: 'api-docs-mcp',
        version: '1.0.0',
        docs_loaded: cachedDocs.length,
        tools: ['list_available_docs', 'search_docs', 'get_docs_by_id', 'get_api_reference', 'get_code_example'],
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
    log.info('Refreshing documentation cache...');
    try {
        // Re-read Actor input for refresh
        const input = await Actor.getInput<ActorInput>() ?? {};
        const startUrls = input.startUrls?.map((item) => item.url) ?? undefined;
        const maxPages = input.maxPages ?? undefined;

        log.info('Refreshing with configuration:', { startUrls, maxPages });

        cachedDocs = await scrapeApifyDocs({
            startUrls,
            maxPages,
        });
        await Actor.setValue('scraped-docs', cachedDocs);
        res.json({ success: true, docs_loaded: cachedDocs.length });
    } catch (error) {
        log.error('Failed to refresh docs:', { error });
        res.status(500).json({ success: false, error: 'Failed to refresh documentation' });
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
    log.info(`Documentation pages loaded: ${cachedDocs.length}`);

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
