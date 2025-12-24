// Documentation scraper with recursive chunking
import { CheerioCrawler } from 'crawlee';
import { log } from 'apify';
import * as cheerio from 'cheerio';
import { v4 as uuidv4 } from 'uuid';
import { DocChunk, DocMetadata, ScraperOptions, ScrapedPage, ParsedSection } from './types.js';
import { generateEmbeddings, estimateTokens } from './embeddings.js';
import { getVectorDB } from './vectordb.js';

// Chunking configuration
const MIN_CHUNK_TOKENS = 100;
const TARGET_CHUNK_TOKENS = 600;
const MAX_CHUNK_TOKENS = 1000;

/**
 * Parse HTML content into structured sections based on headers
 */
function parseHtmlToSections($: cheerio.CheerioAPI): ParsedSection[] {
    const sections: ParsedSection[] = [];
    const contentSelector = 'article, main, .content, body';
    const content = $(contentSelector).first();

    // Get all headers and content elements
    const elements: Array<{ type: 'header' | 'content'; level?: number; text: string }> = [];

    content.find('h1, h2, h3, h4, h5, h6, p, ul, ol, pre, blockquote, table').each((_, el) => {
        const $el = $(el);
        const tagName = el.tagName.toLowerCase();

        if (tagName.match(/^h[1-6]$/)) {
            const level = parseInt(tagName[1], 10);
            elements.push({ type: 'header', level, text: $el.text().trim() });
        } else {
            // For code blocks, preserve formatting
            let text: string;
            if (tagName === 'pre') {
                text = $el.text().trim();
                if (text) {
                    text = '```\n' + text + '\n```';
                }
            } else if (tagName === 'table') {
                // Simple table to text conversion
                const rows: string[] = [];
                $el.find('tr').each((_, row) => {
                    const cells: string[] = [];
                    $(row).find('th, td').each((_, cell) => {
                        cells.push($(cell).text().trim());
                    });
                    rows.push(cells.join(' | '));
                });
                text = rows.join('\n');
            } else {
                text = $el.text().trim();
            }

            if (text) {
                elements.push({ type: 'content', text });
            }
        }
    });

    // Build hierarchical section tree
    function buildSectionTree(startIdx: number, parentLevel: number): { sections: ParsedSection[]; endIdx: number } {
        const result: ParsedSection[] = [];
        let i = startIdx;
        let currentSection: ParsedSection | null = null;
        let contentBuffer: string[] = [];

        while (i < elements.length) {
            const el = elements[i];

            if (el.type === 'header' && el.level !== undefined) {
                // Save previous section's content
                if (currentSection && contentBuffer.length > 0) {
                    currentSection.content = contentBuffer.join('\n\n');
                    contentBuffer = [];
                }

                // If we hit a header at or above parent level, we're done with this level
                if (el.level <= parentLevel) {
                    break;
                }

                // Create new section
                currentSection = {
                    level: el.level,
                    heading: el.text,
                    content: '',
                    children: [],
                };
                result.push(currentSection);
                i++;

                // Recursively get children
                const childResult = buildSectionTree(i, el.level);
                currentSection.children = childResult.sections;
                i = childResult.endIdx;
            } else {
                // Content element
                contentBuffer.push(el.text);
                i++;
            }
        }

        // Save final section's content
        if (currentSection && contentBuffer.length > 0) {
            currentSection.content = contentBuffer.join('\n\n');
        } else if (!currentSection && contentBuffer.length > 0) {
            // Content before any header - create intro section
            result.unshift({
                level: 0,
                heading: 'Introduction',
                content: contentBuffer.join('\n\n'),
                children: [],
            });
        }

        return { sections: result, endIdx: i };
    }

    return buildSectionTree(0, 0).sections;
}

/**
 * Flatten sections into chunks with proper context
 */
function sectionsToChunks(
    sections: ParsedSection[],
    docId: string,
    docTitle: string,
    docUrl: string,
    parentPath: string[] = [],
): DocChunk[] {
    const chunks: DocChunk[] = [];
    let chunkIndex = 0;

    function processSection(section: ParsedSection, path: string[]): void {
        const currentPath = section.heading ? [...path, section.heading] : path;
        const content = section.content.trim();

        if (content) {
            const tokens = estimateTokens(content);

            // If content is too large, split by paragraphs
            if (tokens > MAX_CHUNK_TOKENS) {
                const paragraphs = content.split(/\n\n+/);
                let buffer = '';
                let bufferTokens = 0;

                for (const para of paragraphs) {
                    const paraTokens = estimateTokens(para);

                    if (bufferTokens + paraTokens > TARGET_CHUNK_TOKENS && buffer) {
                        // Emit current buffer as chunk
                        chunks.push({
                            id: uuidv4(),
                            doc_id: docId,
                            doc_title: docTitle,
                            doc_url: docUrl,
                            section_path: currentPath,
                            heading: section.heading || currentPath[currentPath.length - 1] || 'Content',
                            content: buffer.trim(),
                            token_count: bufferTokens,
                            chunk_index: chunkIndex++,
                        });
                        buffer = para;
                        bufferTokens = paraTokens;
                    } else {
                        buffer += (buffer ? '\n\n' : '') + para;
                        bufferTokens += paraTokens;
                    }
                }

                // Emit remaining buffer
                if (buffer && bufferTokens >= MIN_CHUNK_TOKENS) {
                    chunks.push({
                        id: uuidv4(),
                        doc_id: docId,
                        doc_title: docTitle,
                        doc_url: docUrl,
                        section_path: currentPath,
                        heading: section.heading || currentPath[currentPath.length - 1] || 'Content',
                        content: buffer.trim(),
                        token_count: bufferTokens,
                        chunk_index: chunkIndex++,
                    });
                } else if (buffer && chunks.length > 0) {
                    // Merge small remainder with previous chunk
                    const lastChunk = chunks[chunks.length - 1];
                    lastChunk.content += '\n\n' + buffer.trim();
                    lastChunk.token_count += bufferTokens;
                }
            } else if (tokens >= MIN_CHUNK_TOKENS) {
                // Content is appropriate size
                chunks.push({
                    id: uuidv4(),
                    doc_id: docId,
                    doc_title: docTitle,
                    doc_url: docUrl,
                    section_path: currentPath,
                    heading: section.heading || currentPath[currentPath.length - 1] || 'Content',
                    content,
                    token_count: tokens,
                    chunk_index: chunkIndex++,
                });
            } else if (chunks.length > 0) {
                // Too small - merge with previous chunk
                const lastChunk = chunks[chunks.length - 1];
                lastChunk.content += '\n\n' + content;
                lastChunk.token_count += tokens;
            } else {
                // First chunk is small - still create it
                chunks.push({
                    id: uuidv4(),
                    doc_id: docId,
                    doc_title: docTitle,
                    doc_url: docUrl,
                    section_path: currentPath,
                    heading: section.heading || 'Introduction',
                    content,
                    token_count: tokens,
                    chunk_index: chunkIndex++,
                });
            }
        }

        // Process children
        for (const child of section.children) {
            processSection(child, currentPath);
        }
    }

    for (const section of sections) {
        processSection(section, parentPath);
    }

    return chunks;
}

/**
 * Generate a summary from the first chunk or intro section
 */
function generateSummary(chunks: DocChunk[]): string {
    if (chunks.length === 0) return '';

    // Find intro or first chunk
    const introChunk = chunks.find((c) => c.heading.toLowerCase().includes('intro')) || chunks[0];
    const summary = introChunk.content.substring(0, 300);

    // Truncate at sentence boundary if possible
    const lastPeriod = summary.lastIndexOf('.');
    if (lastPeriod > 100) {
        return summary.substring(0, lastPeriod + 1);
    }
    return summary + '...';
}

/**
 * Extract top-level sections from chunks
 */
function extractSections(chunks: DocChunk[]): string[] {
    const sections = new Set<string>();
    for (const chunk of chunks) {
        if (chunk.section_path.length > 0) {
            sections.add(chunk.section_path[0]);
        }
    }
    return Array.from(sections);
}

/**
 * Scrape documentation and store with chunking and embeddings
 */
export async function scrapeDocs(options: ScraperOptions = {}): Promise<{ docsProcessed: number; chunksCreated: number }> {
    const {
        startUrls = [
            'https://docs.apify.com/sdk/js/docs',
            'https://docs.apify.com/sdk/js/reference',
        ],
        maxPages = 100,
    } = options;

    // Auto-generate URL patterns from start URLs
    const urlPatterns = startUrls.map((url) => {
        try {
            const urlObj = new URL(url);
            const base = urlObj.origin + urlObj.pathname.replace(/\/$/, '');
            return `${base}/**`;
        } catch {
            return url;
        }
    });
    log.info('Auto-generated URL patterns:', urlPatterns);

    const scrapedPages: ScrapedPage[] = [];
    let pagesProcessed = 0;

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxPages,
        async requestHandler({ request, $, enqueueLinks }) {
            log.info(`Scraping: ${request.url}`);

            // Extract title
            const title = $('h1').first().text().trim()
                || $('title').first().text().trim()
                || $('h2').first().text().trim()
                || 'Untitled';

            // Get full HTML for parsing
            const html = $.html();

            // Determine page type
            let type: 'api' | 'guide' | 'example' = 'guide';
            if (request.url.includes('/api/') || request.url.includes('/reference/')) type = 'api';
            if (request.url.includes('/examples/') || request.url.includes('/example')) type = 'example';

            scrapedPages.push({
                url: request.url,
                title,
                html,
                type,
            });
            pagesProcessed++;

            // Enqueue more links
            await enqueueLinks({
                globs: urlPatterns,
                exclude: ['**/*.pdf', '**/*.zip', '**/*.png', '**/*.jpg'],
            });
        },
    });

    // Run crawler
    await crawler.run(startUrls);
    log.info(`Scraped ${scrapedPages.length} pages`);

    // Process pages: chunk, embed, store
    const vectorDb = getVectorDB();
    let totalChunks = 0;

    for (let i = 0; i < scrapedPages.length; i++) {
        const page = scrapedPages[i];
        log.info(`Processing page ${i + 1}/${scrapedPages.length}: ${page.title}`);

        // Parse HTML to sections
        const $ = cheerio.load(page.html);
        const sections = parseHtmlToSections($);

        // Generate doc ID
        const docId = `doc-${i + 1}`;

        // Convert sections to chunks
        const chunks = sectionsToChunks(sections, docId, page.title, page.url);

        if (chunks.length === 0) {
            log.warning(`No chunks generated for: ${page.url}`);
            continue;
        }

        log.info(`Generated ${chunks.length} chunks for: ${page.title}`);

        // Generate embeddings for all chunks
        const texts = chunks.map((c) => `${c.heading}\n\n${c.content}`);
        const embeddings = await generateEmbeddings(texts);

        // Attach embeddings to chunks
        for (let j = 0; j < chunks.length; j++) {
            chunks[j].embedding = embeddings[j];
        }

        // Create metadata
        const metadata: DocMetadata = {
            id: docId,
            title: page.title,
            url: page.url,
            summary: generateSummary(chunks),
            sections: extractSections(chunks),
            total_chunks: chunks.length,
            type: page.type,
        };

        // Store in database
        await vectorDb.upsertDocMetadata(metadata);
        await vectorDb.upsertChunks(chunks);

        totalChunks += chunks.length;
        log.info(`Stored ${chunks.length} chunks for doc: ${docId}`);
    }

    log.info(`Total: ${scrapedPages.length} docs, ${totalChunks} chunks`);
    return { docsProcessed: scrapedPages.length, chunksCreated: totalChunks };
}

// Re-export types for backwards compatibility
export type { DocChunk, DocMetadata };
