# Toolbelt for AI Assisted Confluence Page Editing

This repository contains the required tools to edit Confluence pages offline, let Cursor or other AI agents edit the pages, and then upload the changes back to Confluence.

This tool is completely Vibe coded in an afternoon and might be buggy. Use at your own risk.

## Usage and Use Cases

Initialize your local environment by running `npx @tobisk/confluence-tools init`. This will create a .env file in the current folder with the required variables and some comments what they are required for.

### AI Assisted Editing/ Offline Editing

To use this tool, simply create a markdown (.md) file in current folder or any subfolder of it. The document must have a header with the following format:

```
<!--
spaceId: 123
pageId: 456
-->
```

You also need a .env file in the folder you execute the commands from. The file must contain the following variables:

```
CONFLUENCE_BASE_URL=https://your-confluence-instance.com
CONFLUENCE_EMAIL=your-email
CONFLUENCE_API_TOKEN=your-api-token
```

Then run a `npx @tobisk/confluence-tools pull` to download the current page content from confluence. Now edit the file as you please. (or `npm run confluence:download` for development)

Then run a `npx @tobisk/confluence-tools upload` to upload the changes back to confluence. (or `npm run confluence:upload` for development)

We will later support an additional command `npx @tobisk/confluence-tools sync` where we internally download the current page content before the upload and provide you with git diffing before the actual upload. For now, we suggest you to manually use git for being sure about your changes. (or `npm run confluence:sync` for development)

You can also create a new page by running `npx @tobisk/confluence-tools create`. This will create a new markdown file in the current folder with the header and the page content. (or `npm run confluence:create` for development)

### Create a Jira Task

Run `npm run confluence:task` to create a new Jira issue (Task) via prompts:

- Title
- Content (multiline; press Ctrl+Enter to submit)
- Assign to yourself (default Yes)

Required `.env` variables:

```
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_PROJECT_KEY=ABC
# Auth: either access token OR basic auth
JIRA_ACCESS_TOKEN=...
# or
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...

# Optional defaults
JIRA_ISSUE_TYPE=Task
JIRA_PRIORITY=Medium
JIRA_LABELS=docs,automation
JIRA_COMPONENTS=Documentation
```

## Markdown Format

We store the confluence page content in markdown files. The markdown format is slightly modified to support the confluence storage format and especially confluence widgets. This also means that we might not support all layouting features of Confluence.

### Confirmed Widgets & Layouting Features:

- Page Title
- TOC
- Code Blocks
- Tables (No Column Spanning & Cell Styles)
- Lists
- Headings
- Paragraphs
- Inline formatting (bold, italic, code)
- Block formatting (block quotes, info panels)
- Images

We also try to contain comments and mentions as well as possible, but this behaviour is not exhaustively tested.

### Header format (must be at the top of the file)

```
<!--
spaceId: 123
pageId: 456
-->
```

### Inline tag format (place immediately before a block you want to map)

```
<!-- tag:content nodeId:789 -->
```

### Environment

- `CONFLUENCE_BASE_URL` (or `CONFLUENCE_URL`)
- `CONFLUENCE_EMAIL`
- `CONFLUENCE_API_TOKEN`


### Notes

- Partial updates rely on inline tags and the presence of stable `data-node-id` attributes in storage HTML. If node IDs are missing or unmappable, the CLI falls back to full-page updates.
- Review diffs after downloads and before uploads.


