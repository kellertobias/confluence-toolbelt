![Tobisk Confluence Tools](https://github.com/kellertobias/confluence-toolbelt/raw/main/.docs/header.png)

# Toolbelt for AI Assisted Confluence Page Editing

This repository contains the required tools to download Confluence pages as markdown files, let Cursor or other AI agents edit the pages, and then upload the changes back to Confluence including preserving (most) comments and mentions.

⚠️ This tool is completely Vibe coded in an afternoon. The code looks terrible and might be buggy. But it solves the problem I needed it for and the engineers in my company love it. Use at your own risk.

## Usage and Use Cases

Initialize your local environment by running `npx @tobisk/confluence-tools init`. This will:
- Initialize a git repository (if not already initialized)
- Create a `.gitignore` file with recommended entries
- Create a `.env` file with required variables and helpful comments
- Ensure `.env` is added to `.gitignore` to prevent credential leaks

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

Then run a `npx @tobisk/confluence-tools download` to download the current page content from confluence. Now edit the file as you please. (or `npm run confluence:download` for development)

### Download from URL

You can also download pages directly from Confluence URLs:

```bash
npx @tobisk/confluence-tools download https://your-domain.atlassian.net/wiki/spaces/SPACE/pages/123456/Page+Title
```

Or using just the pageId:

```bash
npx @tobisk/confluence-tools download 123456
```

**Custom file path:** Specify where to save the file as a second argument:

```bash
npx @tobisk/confluence-tools download https://... docs/my-page.md
npx @tobisk/confluence-tools download 123456 path/to/file.md
```

When downloading from a URL or pageId, the tool will:
- Extract the pageId from the URL
- Fetch page metadata from the Confluence API
- Create a file named `YYMMDD-Title.md` (or use your custom path if provided) where the date is the last published date
- Automatically commit the file to git

You can download multiple pages at once (without custom paths):

```bash
npx @tobisk/confluence-tools download URL1 URL2 URL3
```

![Tobisk Confluence Tools](https://github.com/kellertobias/confluence-toolbelt/raw/main/.docs/upload-example.png)

Then run a `npx @tobisk/confluence-tools upload` to upload the changes back to confluence. The upload command supports several modes:
- **No arguments**: Shows an interactive file selection menu (files with git changes appear first)
- **`--all` flag**: Uploads all markdown files in the current folder and subfolders
- **Explicit file paths**: Upload specific files, e.g., `upload docs/page1.md docs/page2.md`
- **`--verbose` flag**: Show detailed information about the upload process

The interactive menu shows all files with a `pageId` (excluding READONLY files), with changed files marked with ● and unchanged files with ○.

(or `npm run confluence:upload` for development)

You can also create a new page by running `npx @tobisk/confluence-tools create`. This will create a new markdown file in the current folder with the header and the page content. (or `npm run confluence:create` for development)

### Create a Jira Task

Run `npm run confluence:task` to create a new Jira issue (Task) via prompts:

- Title
- Content (multiline; press Ctrl+Enter to submit)
- Assign to yourself (default Yes)

It also can set default values for fields like Team, Project, etc. to avoid typing them every time.

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
JIRA_DEFAULT_FIELDS='{}' # Optional: default fields for the Jira issue
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
title: Page Title
status: green:In Progress
-->
```

#### Optional Header Fields

- **`READONLY`**: When this flag is present (must be first line after `<!--`), the file will be downloaded but never uploaded. Useful for reference pages that should not be modified locally.
  ```
  <!--
  READONLY
  spaceId: 123
  pageId: 456
  -->
  ```
- **`title`**: Override the page title (optional)
- **`status`**: Add a status label to the page title in format `color:Label text`, e.g., `green:In Progress` (optional)

### Inline tag format (place immediately before a block you want to map)

```
<!-- tag:content nodeId:789 -->
```

### Environment

- `CONFLUENCE_BASE_URL` (or `CONFLUENCE_URL`)
- `CONFLUENCE_EMAIL`
- `CONFLUENCE_API_TOKEN`
- `NO_AUTO_COMMIT` (optional) - When set (to any value), disables automatic git commits after download and upload operations


### Notes

- **Automatic Git Commits**: Both download and upload commands automatically commit changes to git for version tracking. This keeps your git history in sync with Confluence. To disable this behavior, set the `NO_AUTO_COMMIT` environment variable (e.g., `export NO_AUTO_COMMIT=1` or `NO_AUTO_COMMIT=1 npx @tobisk/confluence-tools upload`).
- Partial updates rely on inline tags and the presence of stable `data-node-id` attributes in storage HTML. If node IDs are missing or unmappable, the CLI falls back to full-page updates.
- Review diffs after downloads and before uploads.


