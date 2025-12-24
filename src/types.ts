// Shared type definitions for RAG-based documentation system

export interface DocChunk {
    id: string;                    // UUID from database
    doc_id: string;                // Parent document ID
    doc_title: string;             // Parent document title
    doc_url: string;               // Source URL
    section_path: string[];        // Breadcrumb: ["Guide", "Best Practices", "Mobile"]
    heading: string;               // Current section heading
    content: string;               // Chunk text content
    token_count: number;           // Approximate tokens
    chunk_index: number;           // Order within document
    embedding?: number[];          // Vector embedding (1536 dims)
}

export interface DocMetadata {
    id: string;
    title: string;
    url: string;
    summary: string;               // Auto-generated or first paragraph
    sections: string[];            // List of top-level section headings
    total_chunks: number;
    type: 'api' | 'guide' | 'example';
    created_at?: string;
}

// Search result with similarity score
export interface SearchResult {
    chunk: DocChunk;
    similarity: number;            // 0-1, higher is more similar
}

// Scraper configuration
export interface ScraperOptions {
    startUrls?: string[];
    maxPages?: number;
}

// Raw scraped page before chunking
export interface ScrapedPage {
    url: string;
    title: string;
    html: string;
    type: 'api' | 'guide' | 'example';
}

// Parsed section from HTML
export interface ParsedSection {
    level: number;                 // 1 for H1, 2 for H2, etc.
    heading: string;
    content: string;               // Text content under this heading
    children: ParsedSection[];     // Nested sections
}

// Database row types (matching Supabase schema)
export interface DbDocMetadata {
    id: string;
    title: string;
    url: string;
    summary: string | null;
    sections: string[] | null;
    total_chunks: number | null;
    type: string | null;
    created_at: string;
}

export interface DbDocChunk {
    id: string;
    doc_id: string | null;
    doc_title: string | null;
    doc_url: string | null;
    section_path: string[] | null;
    heading: string | null;
    content: string;
    token_count: number | null;
    chunk_index: number | null;
    embedding: number[] | null;
    created_at: string;
}

// Supabase RPC response for search
export interface SearchChunkResult {
    id: string;
    doc_id: string;
    doc_title: string;
    section_path: string[];
    heading: string;
    content: string;
    similarity: number;
}
