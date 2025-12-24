// MCP tools for RAG-based documentation retrieval
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { getVectorDB } from './vectordb.js';
import { generateEmbedding } from './embeddings.js';

export function registerTools(server: McpServer) {
    const vectorDb = getVectorDB();

    // Tool 1: List Documents (lightweight overview)
    server.registerTool(
        'list_docs',
        {
            description: 'List all available documentation. Returns metadata only (id, title, summary, sections) without full content. Use this to discover what documentation is available.',
            inputSchema: {
                type: z.enum(['all', 'api', 'guide', 'example']).optional().default('all').describe('Filter by document type'),
            },
        },
        async ({ type }): Promise<CallToolResult> => {
            try {
                log.info(`Listing docs of type: ${type}`);

                const docs = await vectorDb.listDocs(type === 'all' ? undefined : type);

                const summary = docs.map((d) => ({
                    id: d.id,
                    title: d.title,
                    type: d.type,
                    summary: d.summary,
                    sections: d.sections,
                    total_chunks: d.total_chunks,
                    url: d.url,
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    total: docs.length,
                                    docs: summary,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in list_docs:', { error });
                throw error;
            }
        },
    );

    // Tool 2: Semantic Search (main entry point)
    server.registerTool(
        'search',
        {
            description: 'Semantic search across all documentation. Returns the most relevant chunks based on meaning, not just keyword matching. Use this as your primary way to find information.',
            inputSchema: {
                query: z.string().describe('Natural language search query - describe what you\'re looking for'),
                limit: z.number().optional().default(5).describe('Maximum number of chunks to return (default: 5)'),
            },
        },
        async ({ query, limit }): Promise<CallToolResult> => {
            try {
                log.info(`Semantic search for: ${query}`);

                // Generate embedding for query
                const queryEmbedding = await generateEmbedding(query);

                // Search similar chunks
                const results = await vectorDb.searchSimilar(queryEmbedding, limit);

                const formattedResults = results.map((r) => ({
                    doc_id: r.doc_id,
                    doc_title: r.doc_title,
                    section: r.section_path.join(' > '),
                    heading: r.heading,
                    content: r.content,
                    similarity: r.similarity.toFixed(3),
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    query,
                                    results_count: results.length,
                                    results: formattedResults,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in search:', { error });
                throw error;
            }
        },
    );

    // Tool 3: Get Document Overview
    server.registerTool(
        'get_doc_overview',
        {
            description: 'Get overview of a specific document including its summary and section structure. Use this before diving into specific sections.',
            inputSchema: {
                doc_id: z.string().describe('Document ID (e.g., "doc-1")'),
            },
        },
        async ({ doc_id }): Promise<CallToolResult> => {
            try {
                log.info(`Getting overview for doc: ${doc_id}`);

                const metadata = await vectorDb.getDocMetadata(doc_id);

                if (!metadata) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'Document not found',
                                    doc_id,
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
                                    id: metadata.id,
                                    title: metadata.title,
                                    type: metadata.type,
                                    url: metadata.url,
                                    summary: metadata.summary,
                                    sections: metadata.sections,
                                    total_chunks: metadata.total_chunks,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in get_doc_overview:', { error });
                throw error;
            }
        },
    );

    // Tool 4: Get Section Content
    server.registerTool(
        'get_section',
        {
            description: 'Get content of a specific section within a document. Use the section names from get_doc_overview.',
            inputSchema: {
                doc_id: z.string().describe('Document ID (e.g., "doc-1")'),
                section: z.string().describe('Section name to retrieve (e.g., "Best Practices", "Examples")'),
            },
        },
        async ({ doc_id, section }): Promise<CallToolResult> => {
            try {
                log.info(`Getting section "${section}" from doc: ${doc_id}`);

                const chunks = await vectorDb.getChunksBySection(doc_id, [section]);

                if (chunks.length === 0) {
                    // Try partial match
                    const { chunks: allChunks } = await vectorDb.getChunks(doc_id);
                    const matchingChunks = allChunks.filter((c) =>
                        c.section_path.some((p) => p.toLowerCase().includes(section.toLowerCase()))
                        || c.heading.toLowerCase().includes(section.toLowerCase()),
                    );

                    if (matchingChunks.length === 0) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: 'Section not found',
                                        doc_id,
                                        section,
                                        available_sections: [...new Set(allChunks.flatMap((c) => c.section_path))],
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
                                        doc_id,
                                        section,
                                        chunks_count: matchingChunks.length,
                                        chunks: matchingChunks.map((c) => ({
                                            heading: c.heading,
                                            section_path: c.section_path.join(' > '),
                                            content: c.content,
                                        })),
                                    },
                                    null,
                                    2,
                                ),
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
                                    doc_id,
                                    section,
                                    chunks_count: chunks.length,
                                    chunks: chunks.map((c) => ({
                                        heading: c.heading,
                                        section_path: c.section_path.join(' > '),
                                        content: c.content,
                                    })),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in get_section:', { error });
                throw error;
            }
        },
    );

    // Tool 5: Get Chunks (paginated access to all chunks)
    server.registerTool(
        'get_chunks',
        {
            description: 'Get chunks from a document with pagination. Use sparingly - prefer search or get_section for targeted retrieval.',
            inputSchema: {
                doc_id: z.string().describe('Document ID (e.g., "doc-1")'),
                limit: z.number().optional().default(10).describe('Number of chunks to return (default: 10)'),
                offset: z.number().optional().default(0).describe('Offset for pagination (default: 0)'),
            },
        },
        async ({ doc_id, limit, offset }): Promise<CallToolResult> => {
            try {
                log.info(`Getting chunks for doc: ${doc_id}, limit: ${limit}, offset: ${offset}`);

                const { chunks, total } = await vectorDb.getChunks(doc_id, limit, offset);

                if (chunks.length === 0) {
                    const docs = await vectorDb.listDocs();
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'Document not found or has no chunks',
                                    doc_id,
                                    available_docs: docs.slice(0, 10).map((d) => d.id),
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
                                    doc_id,
                                    total_chunks: total,
                                    returned: chunks.length,
                                    offset,
                                    has_more: offset + chunks.length < total,
                                    chunks: chunks.map((c) => ({
                                        chunk_index: c.chunk_index,
                                        heading: c.heading,
                                        section_path: c.section_path.join(' > '),
                                        content: c.content,
                                        token_count: c.token_count,
                                    })),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in get_chunks:', { error });
                throw error;
            }
        },
    );

    // Tool 6: Search within document
    server.registerTool(
        'search_in_doc',
        {
            description: 'Semantic search within a specific document. Use when you know which document to search but need to find specific information within it.',
            inputSchema: {
                doc_id: z.string().describe('Document ID to search within'),
                query: z.string().describe('Search query'),
                limit: z.number().optional().default(3).describe('Maximum chunks to return'),
            },
        },
        async ({ doc_id, query, limit }): Promise<CallToolResult> => {
            try {
                log.info(`Searching in doc ${doc_id} for: ${query}`);

                // Generate embedding for query
                const queryEmbedding = await generateEmbedding(query);

                // Search similar chunks within doc
                const results = await vectorDb.searchSimilar(queryEmbedding, limit, doc_id);

                if (results.length === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'No matching content found',
                                    doc_id,
                                    query,
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
                                    doc_id,
                                    query,
                                    results_count: results.length,
                                    results: results.map((r) => ({
                                        section: r.section_path.join(' > '),
                                        heading: r.heading,
                                        content: r.content,
                                        similarity: r.similarity.toFixed(3),
                                    })),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error('Error in search_in_doc:', { error });
                throw error;
            }
        },
    );
}
