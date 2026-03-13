# PubMed MCP Server

MCP server for searching and analyzing PubMed articles.

## Setup

```bash
cd mcp-servers/pubmed
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Tools

- `search_pubmed_key_words` — keyword search
- `search_pubmed_advanced` — advanced search (title, author, journal, date range)
- `get_pubmed_article_metadata` — fetch article metadata by PMID
- `download_pubmed_pdf` — download open-access PDF
- `deep_paper_analysis` — generate analysis prompt for a paper
