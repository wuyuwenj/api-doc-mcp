// OpenRouter embeddings client via Apify proxy
import OpenAI from 'openai';
import { log } from 'apify';

// Initialize OpenAI client pointing to OpenRouter via Apify proxy
const openai = new OpenAI({
    baseURL: 'https://openrouter.apify.actor/api/v1',
    apiKey: 'placeholder', // Required but not used, auth via header
    defaultHeaders: {
        Authorization: `Bearer ${process.env.APIFY_TOKEN}`,
    },
});

// Model to use for embeddings
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

// Batch size for embedding requests (OpenAI limit is ~2048 inputs)
const BATCH_SIZE = 100;

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    try {
        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: text.substring(0, 8000), // Truncate to avoid token limits
        });
        return response.data[0].embedding;
    } catch (error) {
        log.error('Failed to generate embedding:', { error });
        throw error;
    }
}

/**
 * Generate embeddings for multiple texts in batches
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const truncatedBatch = batch.map((t) => t.substring(0, 8000));

        log.info(`Generating embeddings for batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)}`);

        try {
            const response = await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: truncatedBatch,
            });

            // Sort by index to maintain order
            const sortedEmbeddings = response.data
                .sort((a, b) => a.index - b.index)
                .map((d) => d.embedding);

            embeddings.push(...sortedEmbeddings);

            // Small delay between batches to avoid rate limits
            if (i + BATCH_SIZE < texts.length) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        } catch (error) {
            log.error(`Failed to generate embeddings for batch starting at ${i}:`, { error });
            throw error;
        }
    }

    return embeddings;
}

/**
 * Get the expected embedding dimensions
 */
export function getEmbeddingDimensions(): number {
    return EMBEDDING_DIMENSIONS;
}

/**
 * Estimate token count for a text (rough approximation)
 * ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}
