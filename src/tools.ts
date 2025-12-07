import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { DocPage } from './scraper.js';

// Helper function for relevance scoring
function calculateRelevance(text: string, query: string): number {
    const words = query.toLowerCase().split(/\s+/);
    let score = 0;

    words.forEach((word) => {
        const regex = new RegExp(word, 'gi');
        const matches = text.match(regex);
        if (matches) {
            score += matches.length;
        }
    });

    return score;
}

export function registerTools(server: McpServer, docs: DocPage[]) {
    // Tool 1: List Available Docs
    server.registerTool(
        'list_available_docs',
        {
            description: 'Lists all available Apify SDK documentation pages. Use this to discover what documentation is available.',
            inputSchema: {
                type: z.enum(['all', 'api', 'guide', 'example']).optional().default('all').describe('Filter by document type'),
            },
        },
        async ({ type }): Promise<CallToolResult> => {
            try {
                log.info(`Listing docs of type: ${type}`);

                const filteredDocs = type === 'all' ? docs : docs.filter((d) => d.type === type);

                const summary = filteredDocs.map((d) => ({
                    id: d.id,
                    title: d.title,
                    type: d.type,
                    url: d.url,
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    total: filteredDocs.length,
                                    pages: summary,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in list_available_docs:', { error });
                throw error;
            }
        },
    );

    // Tool 2: Search Docs
    server.registerTool(
        'search_docs',
        {
            description: 'Search through Apify SDK documentation. Returns the most relevant results based on the search query.',
            inputSchema: {
                query: z.string().describe('Search query - can be keywords, function names, or concepts'),
                result_limit: z.number().optional().default(5).describe('Maximum number of results to return'),
            },
        },
        async ({ query, result_limit }): Promise<CallToolResult> => {
            try {
                log.info(`Searching for: ${query}`);

                const searchTerm = query.toLowerCase();

                // Simple relevance scoring
                const results = docs
                    .map((doc) => ({
                        ...doc,
                        score: calculateRelevance(doc.searchableText, searchTerm),
                    }))
                    .filter((doc) => doc.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, result_limit)
                    .map((doc) => ({
                        id: doc.id,
                        title: doc.title,
                        snippet: doc.snippet,
                        type: doc.type,
                        url: doc.url,
                        relevance: doc.score.toFixed(2),
                    }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ query, results_count: results.length, results }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in search_docs:', { error });
                throw error;
            }
        },
    );

    // Tool 3: Get Docs by ID
    server.registerTool(
        'get_docs_by_id',
        {
            description: 'Retrieve full content of a specific documentation page by its ID. Use this after searching to get complete details.',
            inputSchema: {
                id: z.string().describe('Documentation page ID (e.g., "apify-sdk-1")'),
            },
        },
        async ({ id }): Promise<CallToolResult> => {
            try {
                log.info(`Fetching doc: ${id}`);

                const doc = docs.find((d) => d.id === id);

                if (!doc) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'Document not found',
                                    available_ids: docs.slice(0, 10).map((d) => d.id),
                                }),
                            },
                        ],
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    id: doc.id,
                                    title: doc.title,
                                    type: doc.type,
                                    url: doc.url,
                                    content: doc.content,
                                    apiReference: doc.apiReference,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in get_docs_by_id:', { error });
                throw error;
            }
        },
    );

    // Tool 4: Get API Reference
    server.registerTool(
        'get_api_reference',
        {
            description: 'Get API reference for a specific function, class, or method. Use this to find signatures, parameters, and usage examples.',
            inputSchema: {
                name: z.string().describe('Function, class, or method name (e.g., "Actor.pushData", "CheerioCrawler", "Dataset")'),
            },
        },
        async ({ name }): Promise<CallToolResult> => {
            try {
                log.info(`Getting API reference for: ${name}`);

                const searchName = name.toLowerCase();
                const apiDocs = docs.filter(
                    (d) => d.type === 'api' && (d.title.toLowerCase().includes(searchName) || d.searchableText.includes(searchName)),
                );

                if (apiDocs.length === 0) {
                    // Try broader search
                    const broadResults = docs
                        .filter((d) => d.searchableText.includes(searchName))
                        .slice(0, 3)
                        .map((d) => ({ id: d.id, title: d.title, type: d.type }));

                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: `API reference not found for "${name}"`,
                                    suggestions: broadResults,
                                }),
                            },
                        ],
                    };
                }

                const doc = apiDocs[0];
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    name: doc.title,
                                    type: doc.type,
                                    url: doc.url,
                                    content: doc.content,
                                    apiReference: doc.apiReference,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in get_api_reference:', { error });
                throw error;
            }
        },
    );

    // Tool 5: Get Code Example
    server.registerTool(
        'get_code_example',
        {
            description: 'Get code examples for a specific feature or concept. Use this to find working code snippets.',
            inputSchema: {
                feature: z.string().describe('Feature or concept name (e.g., "CheerioCrawler", "proxy rotation", "request queue")'),
            },
        },
        async ({ feature }): Promise<CallToolResult> => {
            try {
                log.info(`Getting code example for: ${feature}`);

                const searchFeature = feature.toLowerCase();
                const exampleDocs = docs.filter(
                    (d) => (d.type === 'example' || d.apiReference?.example) && d.searchableText.includes(searchFeature),
                );

                if (exampleDocs.length === 0) {
                    // Try to find any doc with code examples
                    const docsWithCode = docs
                        .filter((d) => d.apiReference?.example && d.searchableText.includes(searchFeature))
                        .slice(0, 3);

                    if (docsWithCode.length === 0) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: `No examples found for "${feature}"`,
                                        suggestion: 'Try searching with different keywords using search_docs',
                                    }),
                                },
                            ],
                        };
                    }

                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(
                                    {
                                        feature,
                                        examples: docsWithCode.map((d) => ({
                                            title: d.title,
                                            url: d.url,
                                            code: d.apiReference?.example,
                                        })),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                }

                const doc = exampleDocs[0];
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    feature,
                                    title: doc.title,
                                    url: doc.url,
                                    example: doc.apiReference?.example || doc.content,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in get_code_example:', { error });
                throw error;
            }
        },
    );
}
