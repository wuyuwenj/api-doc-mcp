# Documentation MCP Server

An MCP server that provides AI assistants with searchable access to any documentation you configure. Simply provide the URLs you want scraped, and your AI assistant can search, browse, and retrieve documentation content.

## What It Does

This Actor scrapes documentation websites and makes them available to AI assistants (like Claude) through the Model Context Protocol (MCP). Your AI can then:

- Search through all your documentation
- Get full content of specific pages
- Find code examples
- Look up API references

## Available Tools

| Tool | Description |
|------|-------------|
| `list_available_docs` | List all documentation pages |
| `search_docs` | Search documentation with ranked results |
| `get_docs_by_id` | Get full content of a specific page |
| `get_api_reference` | Look up API reference for functions/classes |
| `get_code_example` | Find code examples for features |

## How to Use

### 1. Configure Your Documentation Sources

When running the Actor, provide:

| Input | Description | Default |
|-------|-------------|---------|
| **Start URLs** | Documentation pages to scrape | Apify SDK docs |
| **Max Pages** | Maximum pages to scrape (1-1000) | 100 |

Example input:
```json
{
  "startUrls": [
    { "url": "https://docs.example.com/getting-started" },
    { "url": "https://docs.example.com/api-reference" }
  ],
  "maxPages": 200
}
```

The Actor will automatically crawl all pages under those URLs.

### 2. Run the Actor

Run the Actor with your configured documentation URLs. Once it finishes scraping, check the **Output tab** for:

- **MCP Server URL** - Your unique endpoint
- **Claude CLI Command** - Ready-to-copy command to add the MCP server

### 3. Connect to Claude Code

Copy the command from the Output tab, which looks like:

```bash
claude mcp add api-docs https://<YOUR_CONTAINER_URL>/mcp --transport http --header "Authorization: Bearer <YOUR_APIFY_TOKEN>"
```

Replace `<YOUR_APIFY_TOKEN>` with your API token from: https://console.apify.com/account/integrations

### 4. Use It

Once connected, your AI assistant can search and retrieve documentation. Try asking things like:
- "What documentation pages are available?"
- "Search the docs for authentication"
- "Show me code examples for the crawler"

## Example Configurations

### Next.js Documentation
```json
{
  "startUrls": [{ "url": "https://nextjs.org/docs" }],
  "maxPages": 200
}
```

### Multiple Documentation Sites
```json
{
  "startUrls": [
    { "url": "https://docs.python.org/3/" },
    { "url": "https://numpy.org/doc/" }
  ],
  "maxPages": 500
}
```

## Refreshing Documentation

To update the cached documentation, send a POST request to `/refresh-docs` on the Actor's URL.

## Pricing

This Actor uses pay-per-event pricing. You're charged for each tool call made by your AI assistant.
