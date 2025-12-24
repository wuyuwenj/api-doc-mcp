// Supabase pgvector client for document storage and retrieval
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { log } from 'apify';
import {
    DocChunk,
    DocMetadata,
    DbDocMetadata,
    DbDocChunk,
    SearchChunkResult,
} from './types.js';

export class VectorDB {
    private client: SupabaseClient;

    constructor() {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            throw new Error('SUPABASE_URL and SUPABASE_KEY environment variables are required');
        }

        this.client = createClient(supabaseUrl, supabaseKey);
        log.info('VectorDB initialized');
    }

    /**
     * Upsert document metadata
     */
    async upsertDocMetadata(metadata: DocMetadata): Promise<void> {
        const { error } = await this.client
            .from('doc_metadata')
            .upsert({
                id: metadata.id,
                title: metadata.title,
                url: metadata.url,
                summary: metadata.summary,
                sections: metadata.sections,
                total_chunks: metadata.total_chunks,
                type: metadata.type,
            });

        if (error) {
            log.error('Failed to upsert doc metadata:', { error });
            throw error;
        }
    }

    /**
     * Upsert chunks with embeddings
     */
    async upsertChunks(chunks: DocChunk[]): Promise<void> {
        // Process in batches to avoid payload limits
        const batchSize = 50;

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);

            const { error } = await this.client
                .from('doc_chunks')
                .upsert(
                    batch.map((chunk) => ({
                        id: chunk.id,
                        doc_id: chunk.doc_id,
                        doc_title: chunk.doc_title,
                        doc_url: chunk.doc_url,
                        section_path: chunk.section_path,
                        heading: chunk.heading,
                        content: chunk.content,
                        token_count: chunk.token_count,
                        chunk_index: chunk.chunk_index,
                        embedding: chunk.embedding,
                    })),
                );

            if (error) {
                log.error(`Failed to upsert chunks batch ${i}:`, { error });
                throw error;
            }

            log.info(`Upserted chunk batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
        }
    }

    /**
     * Search for similar chunks using vector similarity
     */
    async searchSimilar(embedding: number[], limit: number = 5, docId?: string): Promise<SearchChunkResult[]> {
        const { data, error } = await this.client.rpc('search_chunks', {
            query_embedding: embedding,
            match_count: limit,
            filter_doc_id: docId || null,
        });

        if (error) {
            log.error('Failed to search chunks:', { error });
            throw error;
        }

        return data || [];
    }

    /**
     * Get document metadata by ID
     */
    async getDocMetadata(docId: string): Promise<DocMetadata | null> {
        const { data, error } = await this.client
            .from('doc_metadata')
            .select('*')
            .eq('id', docId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null; // Not found
            log.error('Failed to get doc metadata:', { error });
            throw error;
        }

        const row = data as DbDocMetadata;
        return {
            id: row.id,
            title: row.title,
            url: row.url,
            summary: row.summary || '',
            sections: row.sections || [],
            total_chunks: row.total_chunks || 0,
            type: (row.type as 'api' | 'guide' | 'example') || 'guide',
            created_at: row.created_at,
        };
    }

    /**
     * List all document metadata
     */
    async listDocs(type?: 'api' | 'guide' | 'example'): Promise<DocMetadata[]> {
        let query = this.client
            .from('doc_metadata')
            .select('*')
            .order('created_at', { ascending: false });

        if (type) {
            query = query.eq('type', type);
        }

        const { data, error } = await query;

        if (error) {
            log.error('Failed to list docs:', { error });
            throw error;
        }

        return (data as DbDocMetadata[]).map((row) => ({
            id: row.id,
            title: row.title,
            url: row.url,
            summary: row.summary || '',
            sections: row.sections || [],
            total_chunks: row.total_chunks || 0,
            type: (row.type as 'api' | 'guide' | 'example') || 'guide',
            created_at: row.created_at,
        }));
    }

    /**
     * Get chunks for a document
     */
    async getChunks(docId: string, limit?: number, offset?: number): Promise<{ chunks: DocChunk[]; total: number }> {
        // Get total count
        const { count, error: countError } = await this.client
            .from('doc_chunks')
            .select('*', { count: 'exact', head: true })
            .eq('doc_id', docId);

        if (countError) {
            log.error('Failed to count chunks:', { countError });
            throw countError;
        }

        // Get chunks
        let query = this.client
            .from('doc_chunks')
            .select('*')
            .eq('doc_id', docId)
            .order('chunk_index', { ascending: true });

        if (limit) {
            query = query.limit(limit);
        }
        if (offset) {
            query = query.range(offset, offset + (limit || 10) - 1);
        }

        const { data, error } = await query;

        if (error) {
            log.error('Failed to get chunks:', { error });
            throw error;
        }

        const chunks = (data as DbDocChunk[]).map((row) => ({
            id: row.id,
            doc_id: row.doc_id || '',
            doc_title: row.doc_title || '',
            doc_url: row.doc_url || '',
            section_path: row.section_path || [],
            heading: row.heading || '',
            content: row.content,
            token_count: row.token_count || 0,
            chunk_index: row.chunk_index || 0,
        }));

        return { chunks, total: count || 0 };
    }

    /**
     * Get chunks by section path
     */
    async getChunksBySection(docId: string, sectionPath: string[]): Promise<DocChunk[]> {
        const { data, error } = await this.client
            .from('doc_chunks')
            .select('*')
            .eq('doc_id', docId)
            .contains('section_path', sectionPath)
            .order('chunk_index', { ascending: true });

        if (error) {
            log.error('Failed to get chunks by section:', { error });
            throw error;
        }

        return (data as DbDocChunk[]).map((row) => ({
            id: row.id,
            doc_id: row.doc_id || '',
            doc_title: row.doc_title || '',
            doc_url: row.doc_url || '',
            section_path: row.section_path || [],
            heading: row.heading || '',
            content: row.content,
            token_count: row.token_count || 0,
            chunk_index: row.chunk_index || 0,
        }));
    }

    /**
     * Delete all data for a document
     */
    async deleteDoc(docId: string): Promise<void> {
        // Delete chunks first (foreign key constraint)
        const { error: chunksError } = await this.client
            .from('doc_chunks')
            .delete()
            .eq('doc_id', docId);

        if (chunksError) {
            log.error('Failed to delete chunks:', { chunksError });
            throw chunksError;
        }

        // Delete metadata
        const { error: metaError } = await this.client
            .from('doc_metadata')
            .delete()
            .eq('id', docId);

        if (metaError) {
            log.error('Failed to delete doc metadata:', { metaError });
            throw metaError;
        }

        log.info(`Deleted document: ${docId}`);
    }

    /**
     * Clear all data (use with caution)
     */
    async clearAll(): Promise<void> {
        const { error: chunksError } = await this.client
            .from('doc_chunks')
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

        if (chunksError) {
            log.error('Failed to clear chunks:', { chunksError });
            throw chunksError;
        }

        const { error: metaError } = await this.client
            .from('doc_metadata')
            .delete()
            .neq('id', ''); // Delete all

        if (metaError) {
            log.error('Failed to clear metadata:', { metaError });
            throw metaError;
        }

        log.info('Cleared all data');
    }
}

// Singleton instance
let vectorDbInstance: VectorDB | null = null;

export function getVectorDB(): VectorDB {
    if (!vectorDbInstance) {
        vectorDbInstance = new VectorDB();
    }
    return vectorDbInstance;
}
