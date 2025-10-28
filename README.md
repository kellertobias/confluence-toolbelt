# Toolbelt for AI Assisted Confluence Page Editing

This repository contains the required tools to edit Confluence pages offline, let Cursor or other AI agents edit the pages, and then upload the changes back to Confluence.

This tool is completely Vibe coded in an afternoon and might be buggy. Use at your own risk.

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

Then run a `npx @iu/confluence-tools pull` to download the current page content from confluence. Now edit the file as you please.

Then run a `npx @iu/confluence-tools upload` to upload the changes back to confluence.

We will later support an additional command `npx @iu/confluence-tools sync` where we internally download the current page content before the upload and provide you with git diffing before the actual upload. For now, we suggest you to manually use git for being sure about your changes.

You can also create a new page by running `npx @iu/confluence-tools create`. This will create a new markdown file in the current folder with the header and the page content.

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


