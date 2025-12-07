import { CheerioCrawler } from 'crawlee';
import { log } from 'apify';

export interface DocPage {
    id: string;
    source: string;
    title: string;
    content: string;
    snippet: string;
    type: 'api' | 'guide' | 'example';
    url: string;
    searchableText: string;
    apiReference?: {
        signature?: string;
        parameters?: string[];
        returns?: string;
        example?: string;
    };
}

export interface ScraperOptions {
    startUrls?: string[];
    maxPages?: number;
}

export async function scrapeApifyDocs(options: ScraperOptions = {}): Promise<DocPage[]> {
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
            // Get the origin (protocol + host) and path
            const base = urlObj.origin + urlObj.pathname.replace(/\/$/, '');
            // Add wildcard pattern to crawl all pages under this path
            return `${base}/**`;
        } catch (error) {
            log.warning(`Invalid URL: ${url}`);
            return url;
        }
    });
    log.info('Auto-generated URL patterns:', urlPatterns);

    const docs: DocPage[] = [];

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxPages,
        async requestHandler({ request, $, enqueueLinks }) {
            log.info(`Scraping: ${request.url}`);

            // Extract page data with multiple selector fallbacks
            const title = $('h1').first().text().trim()
                || $('title').first().text().trim()
                || $('h2').first().text().trim()
                || 'Untitled';

            const content = $('article').text().trim()
                || $('main').text().trim()
                || $('.content').text().trim()
                || $('body').text().trim();

            // Debug logging
            log.info(`Extracted - Title: "${title.substring(0, 50)}", Content length: ${content.length}`);

            // Skip empty pages (reduced threshold)
            if (!title || content.length < 20) {
                log.warning(`Skipping page - insufficient content`);
                return;
            }

            // Determine page type
            let type: 'api' | 'guide' | 'example' = 'guide';
            if (request.url.includes('/api/') || request.url.includes('/reference/')) type = 'api';
            if (request.url.includes('/examples/') || request.url.includes('/example')) type = 'example';

            // Create doc page object
            const docPage: DocPage = {
                id: `docs-${docs.length + 1}`,
                source: 'custom-docs',
                title,
                content,
                snippet: content.substring(0, 200) + '...',
                type,
                url: request.url,
                searchableText: `${title} ${content}`.toLowerCase(),
            };

            // Extract API reference data if it's an API page
            if (type === 'api') {
                const codeExample = $('pre code').first().text();
                docPage.apiReference = {
                    signature: $('code.signature, .method-signature').first().text() || undefined,
                    example: codeExample || undefined,
                };
            }

            // Extract code examples from any page
            const codeBlocks = $('pre code').map((_, el) => $(el).text()).get();
            if (codeBlocks.length > 0 && !docPage.apiReference?.example) {
                docPage.apiReference = {
                    ...docPage.apiReference,
                    example: codeBlocks[0],
                };
            }

            docs.push(docPage);

            // Enqueue more links based on provided patterns
            await enqueueLinks({
                globs: urlPatterns,
                exclude: ['**/*.pdf', '**/*.zip', '**/*.png', '**/*.jpg'],
            });
        },
    });

    // Start crawling from provided start URLs
    await crawler.run(startUrls);

    log.info(`Scraped ${docs.length} pages`);
    return docs;
}
