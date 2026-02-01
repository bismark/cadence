---
name: web-search
description: Search the web using Claude CLI with WebSearch tool. Use when you need to find current information, documentation, news, or facts from the internet.
---

# Web Search

Search the web using the local Claude CLI with its built-in WebSearch capability.

## Usage

Run a web search query by piping the prompt (use 120s timeout - web searches can be slow):

```bash
echo "search query here" | claude -p --allowedTools 'WebSearch'
```

When using the Bash tool, set timeout to 120 seconds:
```
timeout: 120
```

Or use the helper script:

```bash
./search.sh "search query here"
```

### Examples

Search for documentation:
```bash
echo "Kotlin Compose Canvas drawText API documentation" | claude -p --allowedTools 'WebSearch'
```

Search for current information:
```bash
echo "ExoPlayer latest version and release notes 2024" | claude -p --allowedTools 'WebSearch'
```

Research a technical topic:
```bash
echo "Android e-ink display optimization best practices" | claude -p --allowedTools 'WebSearch'
```

Find library usage examples:
```bash
echo "Playwright getClientRects examples for text selection" | claude -p --allowedTools 'WebSearch'
```

## Tips

- Be specific in your search queries for better results
- Include version numbers or dates when searching for current information
- The search returns summarized results from Claude's web search
- For multiple related searches, run them sequentially to gather comprehensive information
