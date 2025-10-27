---
title: "README"
sync_to_confluence: true
---

**AUTOMATION NOTICE: This page is synced automatically, changes made manually will be lost**

# Project Docs

Welcome to the documentation. This page is used to validate the Confluence sync in id mode.

## What this page demonstrates

*   Syncing a single page via explicit Confluence page ID mapping
    
*   Frontmatter-based enable flag: `sync_to_confluence: true`
    
*   Automatic automation notice insertion at the top of the Confluence page
    
*   Does comment work?
    

Does online editing work?

## Example content

Here is a simple Mermaid diagram to test attachment generation:

`graph LR A[Start] --> B{Is configured?} B -- Yes --> C[Run dry-run] B -- No --> D[Fix config] C --> E[Run sync] D --> B`
