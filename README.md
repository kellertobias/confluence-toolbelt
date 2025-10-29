![Tobisk Confluence Tools](https://github.com/kellertobias/confluence-toolbelt/raw/main/.docs/header.png)

# Toolbelt for AI Assisted Confluence Page Editing

This repository contains the required tools to download Confluence pages as markdown files, let Cursor or other AI agents edit the pages, and then upload the changes back to Confluence including preserving (most) comments and mentions.

⚠️ This tool is completely Vibe coded in an afternoon. The code looks terrible and might be buggy. But it solves the problem I needed it for and the engineers in my company love it. Use at your own risk.

## Usage and Use Cases

### Initial Setup

Initialize your local environment by running `npx @tobisk/confluence-tools init`. This will:
- Initialize a git repository (if not already initialized)
- Create a `.gitignore` file with recommended entries
- Create a `.env` file with required variables and helpful comments
- Ensure `.env` is added to `.gitignore` to prevent credential leaks

Now edit the .env file with your Confluence and Jira credentials.

### Downloading Pages

You start by downloading pages from Confluence. This can be done by pasting the URL of the page into the command line or by using the pageId.

```bash
npx @tobisk/confluence-tools download https://your-domain.atlassian.net/wiki/spaces/SPACE/pages/123456/Page+Title

# Or using just the pageId:
npx @tobisk/confluence-tools download 123456

# Or with a custom file path as second argument:
npx @tobisk/confluence-tools download https://... docs/my-page.md
npx @tobisk/confluence-tools download 123456 path/to/file.md

# Or in the development mode:
npm run confluence:download /*... args*/
```

When downloading from a URL or pageId, the tool will:
- Extract the pageId from the URL
- Fetch page metadata from the Confluence API
- Create a file named `YYMMDD-Title.md` (or use your custom path if provided) where the date is the last published date
- Automatically commit the file to git

⚠️ If you want a file to be read-only, you can add the `READONLY` flag to the header. This is helpful for reference pages and templates that should not be modified.

### Uploading Changes

![Tobisk Confluence Tools](https://github.com/kellertobias/confluence-toolbelt/raw/main/.docs/upload-example.png)

Then run a `npx @tobisk/confluence-tools upload` (or `npm run confluence:upload` for development) to upload the changes back to confluence. The upload command supports several modes:
- **No arguments**: Shows an interactive file selection menu (files with git changes appear first)
- **`--all` flag**: Uploads all markdown files in the current folder and subfolders
- **Explicit file paths**: Upload specific files, e.g., `upload docs/page1.md docs/page2.md`
- **`--verbose` flag**: Show detailed information about the upload process

The interactive menu shows all files with a `pageId` (excluding READONLY files), with changed files listed first.

### Create a Jira Task

Using Jira can be a hassle, especially if your company has an inflation of custom fields that all need to be set for each new task. This tool helps you create Jira tasks from the command line with the default values, e.g. Team, Project, etc. already set (Set them once in the .env file and you're good to go).

Run `npm run confluence:task` to create a new Jira issue (Task) via prompts:

- Title
- Assign to yourself (default Yes)
- Content (multiline; press Ctrl+D to submit)

Don't forget to setup the .env file with your Jira credentials and default values for the task fields.

### Disable git integration

Both download and upload commands automatically commit changes to git for version tracking. This keeps your git history in sync with Confluence. To disable this behavior, set the `NO_AUTO_COMMIT` environment variable.

## Markdown Format

We store the confluence page content in markdown files. The markdown format is slightly modified to support the confluence storage format and especially confluence widgets. This also means that we might not support all layouting features of Confluence.

### Confirmed Widgets & Layouting Features:

- Page Title & Status
- Tables (No Column Spanning & Cell Styles yet)
- Lists
- Headings
- Paragraphs
- Inline formatting (bold, italic, code, links, mentions)
- Block formatting (block quotes, info panels)
- TOC (Table of Contents)
- Code Blocks
- Images

We also try to contain comments as well as possible, but this behavior is not yet exhaustively tested.

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

There are tags placed in the markdown that control how we map the markdown back to the confluence storage format. These tags should not be removed, since otherwise the changes will not be applied correctly.

```
# example:
<!-- tag:content nodeId:789 -->
```



