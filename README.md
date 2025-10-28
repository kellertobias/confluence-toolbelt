# Toolbelt for AI Assisted Confluence Page Editing

This repository contains the required tools to edit Confluence pages offline, let Cursor or other AI agents edit the pages, and then upload the changes back to Confluence.

This tool is completely Vibe coded in an afternoon and might be buggy. Use at your own risk.

## Usage and Use Cases

### Create Jira Tasks

You can create Jira Tickets in your default board with default fields by:

```
npx @tobisk/confluence-tools task
```

This will create a new Jira Ticket in your default board with default fields. Set them via the `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` environment variables. If you don't have a default board, you can set the `JIRA_BOARD_ID` environment variable to the ID of the board you want to use.

For the default fields, you can set them via the `JIRA_DEFAULT_FIELDS` environment variable. It is a JSON string with the field names as keys and the field values as values.

```
JIRA_DEFAULT_FIELDS='{"summary": "New Task", "description": "New Task Description", "assignee": "your-assignee", "reporter": "your-reporter", "priority": "Medium", "status": "To Do"}'
```

You can also set the `JIRA_DEFAULT_ASSIGNEE` and `JIRA_DEFAULT_REPORTER` environment variables to the email addresses of the assignee and reporter you want to use. Otherwise the current user will be used.

```
JIRA_DEFAULT_ASSIGNEE='your-assignee@example.com'
JIRA_DEFAULT_REPORTER='your-reporter@example.com'
```

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

## Markdown Format

We store the confluence page content in markdown files. The markdown format is slightly modified to support the confluence storage format and especially confluence widgets. This also means that we might not support all layouting features of Confluence.

### Confirmed Widgets:

- TOC

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


