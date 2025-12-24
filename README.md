# Documentation MCP Server (RAG-enabled)

An MCP server that provides AI assistants with **semantic search** access to any documentation. Uses RAG (Retrieval-Augmented Generation) with vector embeddings to find relevant content based on meaning, not just keywords.

## Features

- **Semantic Search** - Find relevant content by meaning, not just keyword matching
- **Recursive Chunking** - Documents split by headers (H1 → H2 → H3) for precise retrieval
- **Low Token Usage** - Returns ~500-1000 tokens per query instead of 15k+ full documents
- **Vector Embeddings** - Uses OpenRouter (text-embedding-3-small) via Apify proxy
- **PostgreSQL + pgvector** - Supabase for scalable vector storage

## Architecture

```
Scrape → Parse HTML → Recursive Chunk → Generate Embeddings → Store in Supabase
                                                                      ↓
User Query → Embed Query → Vector Similarity Search → Return Relevant Chunks
```

## Available Tools

| Tool | Description | Token Usage |
|------|-------------|-------------|
| `list_docs` | List all docs with metadata (id, title, summary, sections) | ~200 |
| `search` | Semantic search across all docs | ~500-1000 |
| `get_doc_overview` | Get document summary and section structure | ~200 |
| `get_section` | Get content of a specific section | ~500-1000 |
| `get_chunks` | Paginated access to all chunks in a doc | ~500-1000 |
| `search_in_doc` | Semantic search within a specific document | ~500-1000 |

## Setup

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a project
2. Go to **SQL Editor** and run the schema below
3. Copy your **Project URL** and **anon key** from Settings → API

### 2. Supabase SQL Schema

Run this in your Supabase SQL Editor:

```sql
-- Enable pgvector extension
create extension if not exists vector;

-- Document metadata table
create table doc_metadata (
    id text primary key,
    title text not null,
    url text not null,
    summary text,
    sections text[],
    total_chunks integer,
    type text,
    created_at timestamp default now()
);

-- Chunks table with vector embeddings
create table doc_chunks (
    id uuid primary key default gen_random_uuid(),
    doc_id text references doc_metadata(id) on delete cascade,
    doc_title text,
    doc_url text,
    section_path text[],
    heading text,
    content text not null,
    token_count integer,
    chunk_index integer,
    embedding vector(1536),
    created_at timestamp default now()
);

-- Function for similarity search
create or replace function search_chunks(
    query_embedding vector(1536),
    match_count int default 5,
    filter_doc_id text default null
)
returns table (
    id uuid,
    doc_id text,
    doc_title text,
    section_path text[],
    heading text,
    content text,
    similarity float
)
language plpgsql
as $$
begin
    return query
    select
        dc.id,
        dc.doc_id,
        dc.doc_title,
        dc.section_path,
        dc.heading,
        dc.content,
        1 - (dc.embedding <=> query_embedding) as similarity
    from doc_chunks dc
    where (filter_doc_id is null or dc.doc_id = filter_doc_id)
    order by dc.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- Optional: Add index for large datasets (1000+ chunks)
-- create index doc_chunks_embedding_idx
-- on doc_chunks using ivfflat (embedding vector_cosine_ops)
-- with (lists = 100);
```

### 3. Configure Environment Variables

Set these in your Apify Actor or use Apify secrets:

```bash
# Add secrets (recommended)
apify secrets add supabaseKey "your-supabase-anon-key"
```

In `.actor/actor.json`:
```json
{
  "environmentVariables": {
    "SUPABASE_URL": "https://your-project.supabase.co",
    "SUPABASE_KEY": "@supabaseKey"
  }
}
```

### 4. Configure Documentation Sources

| Input | Description | Default |
|-------|-------------|---------|
| **Start URLs** | Documentation pages to scrape | Apify SDK docs |
| **Max Pages** | Maximum pages to scrape (1-1000) | 100 |
| **Force Refresh** | Re-scrape even if data exists | false |

Example input:
```json
{
  "startUrls": [
    { "url": "https://docs.example.com/getting-started" },
    { "url": "https://docs.example.com/api-reference" }
  ],
  "maxPages": 200,
  "forceRefresh": false
}
```

### 5. Deploy and Connect

```bash
# Push to Apify
apify push

# Add to Claude Code (get URL from Actor output)
claude mcp add api-docs https://<YOUR_ACTOR_URL>/mcp \
  --transport http \
  --header "Authorization: Bearer <YOUR_APIFY_TOKEN>"
```

## Usage Examples

Once connected, your AI assistant can:

```
"Search the docs for authentication best practices"
→ Returns relevant chunks from multiple documents

"Show me the overview of the API reference doc"
→ Returns summary and section list

"Get the 'Getting Started' section from doc-1"
→ Returns specific section content

"What documentation is available?"
→ Returns list of all docs with summaries
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status and setup instructions |
| `/mcp` | POST | MCP protocol endpoint |
| `/refresh-docs` | POST | Re-scrape and update all documentation |
| `/stats` | GET | Get document and chunk statistics |

## How Chunking Works

Documents are split recursively by headers:

```
Document (15k tokens)
├── H1: Introduction (chunk 1, ~600 tokens)
├── H2: Getting Started
│   ├── H3: Installation (chunk 2, ~400 tokens)
│   └── H3: Configuration (chunk 3, ~500 tokens)
├── H2: API Reference
│   ├── H3: Methods (chunk 4, ~700 tokens)
│   └── H3: Examples (chunk 5, ~600 tokens)
└── ...
```

- **Target chunk size**: 500-800 tokens
- **Max chunk size**: 1000 tokens
- **Min chunk size**: 100 tokens (smaller sections merged with parent)

## Pricing

This Actor uses pay-per-event pricing through Apify. Costs include:
- Scraping: Initial crawl of documentation
- Embeddings: Generated via OpenRouter (charged to Apify account)
- Tool calls: Each MCP tool invocation

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run start:dev

# Build
npm run build

# Push to Apify
apify push
```

## License

ISC
