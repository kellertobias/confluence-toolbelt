import { describe, expect, it } from 'vitest';
import {
  detectUnsupportedFeatures,
  markdownToStorageHtml,
  storageToMarkdownBlocks,
} from '../storage-dom.js';

describe('storageToMarkdownBlocks', () => {
  it('renders TOC macro as placeholder comment', () => {
    const html = `
      <ac:structured-macro ac:name="toc"></ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(`TABLE_OUT:\n${out}`);
    expect(out).toContain('<!-- widget:TOC -->');
  });

  it('self-closing TOC macro does not consume sibling content', () => {
    // Regression: the self-closing `<ac:structured-macro ac:name="toc" />`
    // form was previously matched by the open/close regex because `[^>]*>`
    // consumed through the `/>`, then `[\s\S]*?</ac:structured-macro>` ate
    // all sibling content up to the next unrelated closing tag.
    const html = `
      <p>Intro paragraph.</p>
      <ac:structured-macro ac:name="toc" ac:schema-version="1" ac:macro-id="abc-123" />
      <h1>Section 1</h1>
      <p>Section content.</p>
      <ac:structured-macro ac:name="expand" ac:schema-version="1">
        <ac:parameter ac:name="title">Mermaid</ac:parameter>
        <ac:plain-text-body><![CDATA[flowchart LR
  A --> B]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(out).toContain('<!-- widget:TOC -->');
    // The heading and paragraph after the TOC must NOT be swallowed.
    expect(out).toContain('# Section 1');
    expect(out).toContain('Section content.');
  });

  it('renders GFM table with inline comments preserved', () => {
    const html = `
      <table>
        <tr>
          <th>Title 1</th><th>Title 2</th><th>Title 3</th>
        </tr>
        <tr>
          <td>A</td><td>B</td><td>C</td>
        </tr>
        <tr>
          <td>red<!-- table:bg:red --></td>
          <td>green<!-- table:bg:green --></td>
          <td>blue<!-- table:bg:blue --></td>
        </tr>
      </table>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(out).toContain('| Title 1 | Title 2 | Title 3 |');
    expect(out).toContain('| --- | --- | --- |');
    expect(out).toContain('<!-- cell:bg:red -->');
    expect(out).toContain('<!-- cell:bg:green -->');
    expect(out).toContain('<!-- cell:bg:blue -->');
  });

  it('converts Confluence code macro to fenced code block with language', () => {
    const html = `
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">typescript</ac:parameter>
        <ac:plain-text-body><![CDATA[const x: number = 1;\nconsole.log(x);]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(out).toContain(
      '```typescript\nconst x: number = 1;\nconsole.log(x);\n```',
    );
  });

  it('decodes MD_CODE token into fenced JSON with original content intact', () => {
    const jsonSnippet = [
      '// .cursor/mcp.json or ~/.cursor/mcp.json',
      '{',
      '  "mcpServers": {',
      '    "mcp-atlassian": {',
      '      "command": "docker",',
      '      "args": ["run", "-i", "--rm"],',
      '      "env": {}',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const html = `
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">json</ac:parameter>
        <ac:plain-text-body><![CDATA[${jsonSnippet}]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(out).toContain('```json\n// .cursor/mcp.json or ~/.cursor/mcp.json');
    expect(out).toContain('\n}\n```');
  });

  it('converts fenced code block back to Confluence code macro with language', () => {
    const md = [
      '```bash',
      'echo hello',
      '```',
      '',
      '```',
      'no-lang fence',
      '```',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="code">');
    expect(html).toContain(
      '<ac:parameter ac:name="language">bash</ac:parameter>',
    );
    expect(html).toContain(
      '<ac:plain-text-body><![CDATA[echo hello]]></ac:plain-text-body>',
    );
    expect(html).toContain(
      '<ac:plain-text-body><![CDATA[no-lang fence]]></ac:plain-text-body>',
    );
  });

  it('preserves raw text when CDATA would be broken by ]]>', () => {
    const md = ['```', 'end of cdata ]]> should be escaped', '```'].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="code">');
    expect(html).toContain('<ac:plain-text-body>');
    expect(html).toContain('end of cdata ]]&gt; should be escaped');
  });

  it('converts Confluence code macro to fenced code block', () => {
    const html = `
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">json</ac:parameter>
        <ac:plain-text-body><![CDATA[line1\nline2]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    // Expect fenced block
    expect(out).toContain('```json\nline1\nline2\n```');
  });

  it('parses indented code blocks back to code macro', () => {
    const md = ['    const a = 1;', '    console.log(a);', '', 'Not code'].join(
      '\n',
    );
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="code">');
    expect(html).toContain(
      '<ac:plain-text-body><![CDATA[const a = 1;\nconsole.log(a);]]></ac:plain-text-body>',
    );
  });

  it('converts unordered lists and inline formatting', () => {
    const md = [
      '**bold** and `code` in a paragraph.',
      '',
      '- Item 1',
      '- Item 2',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain(
      '<p><strong>bold</strong> and <code>code</code> in a paragraph.</p>',
    );
    expect(html).toContain('<ul><li>Item 1</li><li>Item 2</li></ul>');
  });

  it('does not swallow a list into a preceding paragraph without a blank line', () => {
    const md = [
      '**Pros:**',
      '- Simpler infrastructure.',
      '- Full control over combining data.',
      '- No new bottleneck team.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<p><strong>Pros:</strong></p>');
    expect(html).toContain(
      '<ul><li>Simpler infrastructure.</li><li>Full control over combining data.</li><li>No new bottleneck team.</li></ul>',
    );
  });

  it('breaks a paragraph before a heading without a blank line', () => {
    const md = ['Intro sentence.', '## Next section', 'Body.'].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<p>Intro sentence.</p>');
    expect(html).toContain('<h2>Next section</h2>');
    expect(html).toContain('<p>Body.</p>');
  });

  it('renders *text* as <em> italics', () => {
    const html = markdownToStorageHtml('*Rejected.*');
    expect(html).toContain('<p><em>Rejected.</em></p>');
  });

  it('strips comment thread tags so they never leak into storage', () => {
    // Canonical form after obsidianToCanonical: a comment wrapper whose thread
    // bodies (`<!-- # Author: body -->`) sit before the anchored text.
    const md =
      'Before <!-- comment:m-1 --><!-- # Alice: first --><!-- # Bob: reply -->the anchor<!-- commend-end:m-1 --> after';
    const html = markdownToStorageHtml(md);
    // The inline marker wraps ONLY the anchor — no thread bodies inside it.
    expect(html).toContain(
      '<ac:inline-comment-marker ac:ref="m-1">the anchor</ac:inline-comment-marker>',
    );
    // Thread tags must not survive anywhere in the uploaded storage.
    expect(html).not.toContain('<!-- #');
    expect(html).not.toContain('Alice');
    expect(html).not.toContain('Bob');
  });

  it('renders italics that wrap a link', () => {
    const md =
      '*→ Full discussion, alternatives: [TDD Discussion](pageid:6273368135)*';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<em>→ Full discussion, alternatives: ');
    expect(html).toContain('<ri:content-entity ri:content-id="6273368135"/>');
    expect(html).toContain('</ac:link></em>');
  });

  it('does not italicize asterisks around whitespace or inside code spans', () => {
    const html = markdownToStorageHtml(
      'Use `a*b` for multiplication, 5 * 3 = 15, and *italic* text.',
    );
    expect(html).toContain('<code>a*b</code>');
    expect(html).toContain('5 * 3 = 15');
    expect(html).toContain('<em>italic</em>');
  });

  it('keeps escaped asterisks literal and does not italicize them', () => {
    const html = markdownToStorageHtml('\\*not italic\\*');
    expect(html).toContain('<p>*not italic*</p>');
    expect(html).not.toContain('<em>');
  });

  it('does not treat indented list items as code blocks on upload', () => {
    const md = [
      '- Parent item',
      '    - Sub item 1',
      '    - Sub item 2',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).not.toContain('ac:name="code"');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Parent item');
    expect(html).toContain('<li>Sub item 1</li>');
    expect(html).toContain('<li>Sub item 2</li>');
  });

  it('handles fully-indented list without parent as a list, not code', () => {
    const md = [
      '    - Item 1',
      '    - Item 2',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).not.toContain('ac:name="code"');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Item 1</li>');
    expect(html).toContain('<li>Item 2</li>');
  });

  it('produces nested <ul> for indented unordered sub-lists', () => {
    const md = [
      '- Parent',
      '    - Child 1',
      '    - Child 2',
      '- Another parent',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ul><li>Parent<ul><li>Child 1</li><li>Child 2</li></ul></li><li>Another parent</li></ul>');
  });

  it('produces nested <ul> when blank line separates parent from sub-list', () => {
    const md = [
      '*   **PIM** — Product Information Management',
      '',
      '*   **CuMo** — Curriculum Management',
      '',
      '*   Other consuming systems:',
      '    ',
      '    *   MyCampus, Learning Systems',
      '    *   Syntea',
      '    *   Salesforce',
      '    *   Website Forms',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    // Sub-items must be nested inside the parent, not a separate flat list
    expect(html).toContain('<li>Other consuming systems:<ul>');
    expect(html).toContain('<li>MyCampus, Learning Systems</li>');
    expect(html).toContain('<li>Syntea</li>');
    expect(html).toContain('<li>Salesforce</li>');
    expect(html).toContain('<li>Website Forms</li>');
    // Should be a single <ul>, not two separate ones
    const ulCount = (html.match(/<ul>/g) || []).length;
    expect(ulCount).toBe(2); // outer + nested
  });

  it('produces nested <ol> for indented ordered sub-lists', () => {
    const md = [
      '1. First',
      '    1. Sub first',
      '    2. Sub second',
      '2. Second',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ol><li>First<ol><li>Sub first</li><li>Sub second</li></ol></li><li>Second</li></ol>');
  });

  it('still treats 4-space indented non-list text as code block', () => {
    const md = ['    const x = 1;', '    console.log(x);'].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('ac:name="code"');
  });

  it('converts ordered lists with inline formatting on upload', () => {
    const md = [
      'This has had compounding effects:',
      '',
      '1. **Every system encounters the same data quality issues** — and addresses them independently, with different assumptions.',
      '2. **The same underlying data gets interpreted differently** across systems, leading to divergent "truths" for the same student record.',
      '3. **New integration points with CARE** make the legacy system harder to decommission, not easier.',
      '4. **Teams build bespoke "shadow" enrollment wrappers** and other workarounds to compensate for CARE\'s lack of native APIs, creating fragmented ownership and technical debt.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<p>This has had compounding effects:</p>');
    expect(html).toContain('<ol>');
    expect(html).toContain(
      '<li><strong>Every system encounters the same data quality issues</strong> — and addresses them independently, with different assumptions.</li>',
    );
    expect(html).toContain(
      '<li><strong>The same underlying data gets interpreted differently</strong> across systems, leading to divergent "truths" for the same student record.</li>',
    );
    expect(html).toContain(
      '<li><strong>New integration points with CARE</strong> make the legacy system harder to decommission, not easier.</li>',
    );
    expect(html).toContain(
      '<li><strong>Teams build bespoke "shadow" enrollment wrappers</strong> and other workarounds to compensate for CARE\'s lack of native APIs, creating fragmented ownership and technical debt.</li>',
    );
  });

  it('decodes literal \\n in table cell markdown back to <br/> on upload', () => {
    const md = ['| Col |', '| --- |', '| line1\\nline2 |'].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<td><p>line1<br/>line2</p></td>');
  });

  it('converts links, mention tags, and blockquotes on upload', () => {
    const md = [
      '> <!-- panel:info:info -->',
      '> **Bold** text with a [link](https://example.com) and <!-- mention:acc-123 User Name -->',
      '',
      '> normal block quote line',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="info">');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain('<ac:atlassian-user ac:account-id="acc-123"/>');
  });

  it('does not escape underscores in download outside code', () => {
    const html = `
      <p>Env: CONFLUENCE_API_TOKEN and CONFLUENCE_USERNAME</p>
    `;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(out).toContain('CONFLUENCE_API_TOKEN');
    expect(out).toContain('CONFLUENCE_USERNAME');
    expect(out).not.toContain('\\_');
  });

  it('does not escape underscores in plain text nodes', () => {
    const html = `Text with CONST_VAR and another_VAR`;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(out).toContain('CONST_VAR');
    expect(out).toContain('another_VAR');
    expect(out).not.toContain('CONST\\_VAR');
  });

  it('collapses double-escaped underscores to single escaped underscore', () => {
    const html = `<p>double: \\_ should normalize</p>`;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(out).toContain('\\_');
  });

  it('preserves status inline tag round-trip', () => {
    const html = `
      <ac:structured-macro ac:name="status">
        <ac:parameter ac:name="title">In Progress</ac:parameter>
        <ac:parameter ac:name="colour">Yellow</ac:parameter>
      </ac:structured-macro>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('<!-- status:yellow:In Progress -->');
    const back = markdownToStorageHtml(md);
    expect(back).toContain('<ac:structured-macro ac:name="status">');
    expect(back).toContain(
      '<ac:parameter ac:name="title">In Progress</ac:parameter>',
    );
    expect(back).toContain(
      '<ac:parameter ac:name="colour">yellow</ac:parameter>',
    );
  });

  it('preserves mention round-trip using mention tag', () => {
    const html = `
      <ac:link><ri:user ri:account-id="abc-123" /></ac:link>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('<!-- mention:abc-123 ');
    const back = markdownToStorageHtml(`${md}\n`);
    expect(back).toContain('<ac:atlassian-user ac:account-id="abc-123"/>');
  });

  it('converts Confluence image with caption to markdown image + caption and back', () => {
    const html = `
      <ac:image>
        <ri:url ri:value="https://example.com/img.png" />
        <ac:caption>Figure 1: Example</ac:caption>
      </ac:image>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('![Figure 1: Example](');
    expect(md).toContain('https://example.com/img.png');
    expect(md).toContain('Figure 1: Example');
    const back = markdownToStorageHtml(md);
    expect(back).toContain('<ac:image');
    expect(back).toContain('<ri:url ri:value="https://example.com/img.png"/>');
    expect(back).toContain('<ac:caption>Figure 1: Example</ac:caption>');
  });

  it('round-trips an attached image (markdown #filename <-> ri:attachment)', () => {
    const md = '![Diagram](#diagram.png)';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:image');
    expect(html).toContain('<ri:attachment ri:filename="diagram.png"/>');

    const back = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(back).toContain('![Diagram](#diagram.png)');
  });

  it('panel macro downloads as blockquote with config tag and uploads back', () => {
    const html = `
      <ac:structured-macro ac:name="info">
        <ac:rich-text-body>
          <p>Be aware of this.</p>
        </ac:rich-text-body>
      </ac:structured-macro>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('> <!-- panel:info:info -->');
    expect(md).toContain('> Be aware of this.');
    const back = markdownToStorageHtml(md);
    expect(back).toContain('<ac:structured-macro ac:name="info">');
    expect(back).toContain('<ac:rich-text-body>');
  });

  it('panel upload correctly converts \\> to literal > in HTML', () => {
    const md = [
      '> <!-- panel:note:note -->',
      '> \\> **Status**: Draft',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="note">');
    expect(html).toContain('&gt;');
    expect(html).not.toContain('\\&gt;');
    expect(html).not.toContain('\\>');
  });

  it('panel with \\> does not accumulate backslashes on repeated upload', () => {
    const md1 = [
      '> <!-- panel:note:note -->',
      '> \\> **Status**: Draft',
    ].join('\n');
    const html1 = markdownToStorageHtml(md1);
    expect(html1).not.toContain('\\');

    const md2 = storageToMarkdownBlocks(`<div>${html1}</div>`)
      .map((b) => b.markdown)
      .join('\n');
    const html2 = markdownToStorageHtml(md2);
    expect(html2).not.toContain('\\');
    expect(html2).toBe(html1);
  });

  it('encodes newlines in table cells as \\n in markdown', () => {
    const html = `
      <table>
        <tr>
          <th>Col</th>
        </tr>
        <tr>
          <td>line1<br/>line2</td>
        </tr>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('| Col |');
    expect(md).toContain('| line1\\nline2 |');
  });

  it('appends cell styling tag and preserves literal \\n in cell content', () => {
    const html = `
      <table>
        <tr><th>Title</th></tr>
        <tr>
          <td>first line<!-- table:bg:#ffeeee --></td>
        </tr>
        <tr>
          <td><p>one</p><p>Two</p><!-- cell:bg:yellow --></td>
        </tr>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    // Styled cell from table:bg
    expect(md).toContain('| first line <!-- cell:bg:#ffeeee --> |');
    // Inline newline and explicit cell:bg
    expect(md).toContain('| one\\nTwo <!-- cell:bg:yellow --> |');
  });

  it('does not escape dots in ordered lists', () => {
    const html = `
      <ol>
        <li>First</li>
        <li>Second</li>
      </ol>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toMatch(/1\.\s+First/);
    expect(md).toMatch(/2\.\s+Second/);
    expect(md).not.toContain('1\\.');
  });

  it('renders horizontal rules as dashed lines', () => {
    const html = `<hr/>`;
    const out = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(out).toBe('-------');
  });

  it('converts Confluence page links to markdown links with page: scheme', () => {
    const html = `
      <p>
        See <ac:link>
          <ri:page ri:content-title="Design Document" />
          <ac:plain-text-link-body><![CDATA[the design doc]]></ac:plain-text-link-body>
        </ac:link> for details.
      </p>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('[the design doc](page:Design Document)');
  });

  it('converts Confluence page links with space key and title to markdown', () => {
    const html = `
      <p>
        Check <ac:link>
          <ri:page ri:space-key="MYSPACE" ri:content-title="My Page" />
          <ac:plain-text-link-body><![CDATA[this page]]></ac:plain-text-link-body>
        </ac:link>
      </p>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    // Title-only (no content-id) still uses page: scheme — resolved downstream.
    expect(md).toContain('[this page](page:MYSPACE:My Page)');
  });

  it('converts Confluence attachment links to markdown with #attachment: scheme', () => {
    const html = `
      <p>
        Download <ac:link>
          <ri:attachment ri:filename="report.pdf" />
          <ac:plain-text-link-body><![CDATA[the report]]></ac:plain-text-link-body>
        </ac:link>
      </p>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('[the report](#attachment:report.pdf)');
  });

  it('converts Confluence URL links within ac:link to markdown', () => {
    const html = `
      <p>
        Visit <ac:link>
          <ri:url ri:value="https://example.com/docs" />
          <ac:plain-text-link-body><![CDATA[our docs]]></ac:plain-text-link-body>
        </ac:link>
      </p>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('[our docs](https://example.com/docs)');
  });

  it('converts markdown page links back to Confluence storage format', () => {
    const md = 'See [the design doc](page:Design Document) for details.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:page ri:content-title="Design Document"/>');
    expect(html).toContain(
      '<ac:plain-text-link-body><![CDATA[the design doc]]></ac:plain-text-link-body>',
    );
  });

  it('converts markdown page links with space key back to Confluence', () => {
    const md = 'Check [this page](page:MYSPACE:My Page) out.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain(
      '<ri:page ri:space-key="MYSPACE" ri:content-title="My Page"/>',
    );
    expect(html).toContain(
      '<ac:plain-text-link-body><![CDATA[this page]]></ac:plain-text-link-body>',
    );
  });

  it('converts markdown attachment links back to Confluence storage format', () => {
    const md = 'Download [the report](#attachment:report.pdf) here.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:attachment ri:filename="report.pdf"/>');
    expect(html).toContain(
      '<ac:plain-text-link-body><![CDATA[the report]]></ac:plain-text-link-body>',
    );
  });

  it('preserves regular URL links in markdown and HTML', () => {
    const md = 'Visit [our website](https://example.com) for more info.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<a href="https://example.com">our website</a>');
  });

  it('round-trips page links through markdown without data loss', () => {
    const originalHtml = `
      <p>
        See <ac:link>
          <ri:page ri:space-key="DEV" ri:content-title="API Reference" />
          <ac:plain-text-link-body><![CDATA[API docs]]></ac:plain-text-link-body>
        </ac:link> for details.
      </p>
    `;
    // Convert to markdown
    const md = storageToMarkdownBlocks(originalHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('[API docs](page:DEV:API Reference)');

    // Convert back to HTML
    const html = markdownToStorageHtml(md);
    expect(html).toContain(
      '<ri:page ri:space-key="DEV" ri:content-title="API Reference"/>',
    );
    expect(html).toContain(
      '<ac:plain-text-link-body><![CDATA[API docs]]></ac:plain-text-link-body>',
    );
  });

  it('converts Jira issue macro to jira: link on download', () => {
    const html = `
      <p>
        See <ac:structured-macro ac:name="jira">
          <ac:parameter ac:name="key">PROJ-123</ac:parameter>
        </ac:structured-macro> for details.
      </p>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('[PROJ-123](jira:PROJ-123)');
  });

  it('converts jira: link back to Jira macro on upload', () => {
    const md = 'See [PROJ-123](jira:PROJ-123) for details.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="jira">');
    expect(html).toContain('<ac:parameter ac:name="key">PROJ-123</ac:parameter>');
  });

  it('round-trips Jira issue links without data loss', () => {
    const originalHtml = `
      <p>See <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">API-42</ac:parameter></ac:structured-macro> for info.</p>
    `;
    const md = storageToMarkdownBlocks(originalHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('[API-42](jira:API-42)');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="jira">');
    expect(html).toContain('<ac:parameter ac:name="key">API-42</ac:parameter>');
  });

  it('converts pageid: links to ri:content-entity on upload', () => {
    const md = 'See [the TDD](pageid:12345) for details.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain(
      '<ri:content-entity ri:content-id="12345"/>',
    );
    expect(html).toContain(
      '<ac:plain-text-link-body><![CDATA[the TDD]]></ac:plain-text-link-body>',
    );
  });

  it('converts ri:content-entity links to pageid: on download', () => {
    const storageHtml = `
      <p>
        See <ac:link>
          <ri:content-entity ri:content-id="67890" />
          <ac:plain-text-link-body><![CDATA[Design Doc]]></ac:plain-text-link-body>
        </ac:link> for info.
      </p>
    `;
    const md = storageToMarkdownBlocks(storageHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('[Design Doc](pageid:67890)');
  });

  it('converts ri:page with ri:content-id and ri:space-key to pageid:SPACE:id on download', () => {
    // Confluence resolves page-by-title refs to ri:content-id on save; the
    // space key must be preserved so the round-trip produces pageid:E:5292327446.
    const storageHtml = `
      <p>
        See <ac:link>
          <ri:page ri:space-key="E" ri:content-id="5292327446" />
          <ac:plain-text-link-body><![CDATA[TDD Doc]]></ac:plain-text-link-body>
        </ac:link> for info.
      </p>
    `;
    const md = storageToMarkdownBlocks(storageHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('[TDD Doc](pageid:E:5292327446)');
  });

  it('round-trips pageid: links through storage HTML', () => {
    const md = '[Care Import TDD](pageid:42)';
    const html = markdownToStorageHtml(md);
    expect(html).toContain(
      '<ri:content-entity ri:content-id="42"/>',
    );

    const roundTripped = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(roundTripped).toContain('[Care Import TDD](pageid:42)');
  });

  it('converts pageid:SPACE:ID to ri:content-entity on upload (space key dropped)', () => {
    const md = 'See [the doc](pageid:MYSPACE:12345) for details.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:content-entity ri:content-id="12345"/>');
    // ri:page does not support ri:content-id — must use content-entity
    expect(html).not.toContain('ri:page');
  });

  it('converts legacy page:SPACE:ID (numeric ID) to ri:content-entity on upload', () => {
    const md = 'See [the doc](page:MYSPACE:12345) for details.';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:content-entity ri:content-id="12345"/>');
    // ri:page does not support ri:content-id — must use content-entity
    expect(html).not.toContain('ri:page');
  });

  it('does not treat page:SPACE:Title as a content-entity link', () => {
    const md = 'See [the doc](page:MYSPACE:My Page Title).';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ri:page');
    expect(html).toContain('ri:space-key="MYSPACE"');
    expect(html).toContain('ri:content-title="My Page Title"');
    expect(html).not.toContain('ri:content-entity');
  });
});

describe('table config (layout and column widths)', () => {
  it('emits <!-- table:wider --> when table has data-table-width="960"', () => {
    const html = `
      <table data-table-width="960">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:wider -->');
    expect(md).toContain('| A | B |');
  });

  it('emits <!-- table:full --> when table has data-table-width="1800"', () => {
    const html = `
      <table data-table-width="1800">
        <thead><tr><th>X</th><th>Y</th></tr></thead>
        <tbody><tr><td>a</td><td>b</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:full -->');
  });

  it('emits column width shares from colgroup on download', () => {
    const html = `
      <table data-table-width="1800">
        <colgroup>
          <col style="width: 100px;" />
          <col style="width: 200px;" />
          <col style="width: 100px;" />
        </colgroup>
        <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:full 1,2,1 -->');
  });

  it('emits content layout with shares when only colgroup differs', () => {
    const html = `
      <table>
        <colgroup>
          <col style="width: 200px;" />
          <col style="width: 300px;" />
        </colgroup>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:content 2,3 -->');
  });

  it('does not emit config for plain table with no width or colgroup', () => {
    const html = `
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).not.toContain('<!-- table:');
  });

  it('does not emit shares when all columns are equal width', () => {
    const html = `
      <table data-table-width="960">
        <colgroup>
          <col style="width: 150px;" />
          <col style="width: 150px;" />
        </colgroup>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:wider -->');
    expect(md).not.toMatch(/<!-- table:wider \d/);
  });

  it('falls back to legacy data-layout for older Confluence content', () => {
    const html = `
      <table data-layout="wide">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:wider -->');
  });

  it('treats content-width data-table-width as no layout', () => {
    const html = `
      <table data-table-width="760">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).not.toContain('<!-- table:');
  });

  it('uploads table with <!-- table:full 1,2,1 --> config', () => {
    const md = [
      '<!-- table:full 1,2,1 -->',
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-table-width="1800"');
    expect(html).toContain('<colgroup>');
    expect(html).toContain('<col style="width: 100px;"');
    expect(html).toContain('<col style="width: 200px;"');
  });

  it('uploads table with <!-- table:wider --> layout only', () => {
    const md = [
      '<!-- table:wider -->',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-table-width="960"');
    expect(html).not.toContain('<colgroup>');
  });

  it('uploads plain table without config comment as before', () => {
    const md = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<table>');
    expect(html).not.toContain('data-table-width');
    expect(html).not.toContain('<colgroup>');
  });

  it('round-trips table config through download and upload', () => {
    const storageHtml = `
      <table data-table-width="1800">
        <colgroup>
          <col style="width: 100px;" />
          <col style="width: 200px;" />
          <col style="width: 100px;" />
        </colgroup>
        <thead><tr><th>Name</th><th>Description</th><th>Status</th></tr></thead>
        <tbody><tr><td>Item</td><td>Details here</td><td>Done</td></tr></tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(storageHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- table:full 1,2,1 -->');

    const backHtml = markdownToStorageHtml(md);
    expect(backHtml).toContain('data-table-width="1800"');
    expect(backHtml).toContain('<colgroup>');
    expect(backHtml).toContain('<col style="width: 100px;"');
    expect(backHtml).toContain('<col style="width: 200px;"');
  });

  it('pads missing column shares with 1 when fewer shares than columns', () => {
    const md = [
      '<!-- table:content 2,3 -->',
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 | 3 |',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<colgroup>');
    expect(html).toContain('<col style="width: 200px;"');
    expect(html).toContain('<col style="width: 300px;"');
    expect(html).toContain('<col style="width: 100px;"');
  });
});

describe('mermaid diagrams', () => {
  it('converts mermaid code block to pako URL image + expand macro on upload', () => {
    const md = '```mermaid\ngraph TD\n    A --> B\n```';
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:image');
    expect(html).toContain('mermaid.ink/img/pako:');
    expect(html).toContain('?type=png');
    expect(html).toContain('ac:name="expand"');
    expect(html).toContain('Mermaid Diagram Source');
    expect(html).toContain('graph TD');
    expect(html).toContain('A --> B');
    expect(html).not.toContain('<!-- mermaid:');
  });

  it('does not affect non-mermaid code blocks', () => {
    const md = '```typescript\nconst x = 1;\n```';
    const html = markdownToStorageHtml(md);
    expect(html).not.toContain('mermaid');
    expect(html).toContain('ac:name="code"');
    expect(html).toContain('ac:name="language">typescript');
  });

  it('reconstructs mermaid code block from expand macro on download', () => {
    const source = 'graph LR\n    X --> Y';
    const storageHtml = `
      <p>Intro</p>
      <ac:image ac:align="center" ac:width="800">
        <ac:parameter ac:name="width">800</ac:parameter>
        <ri:url ri:value="https://mermaid.ink/img/pako:abc123"/>
      </ac:image>
      <ac:structured-macro ac:name="expand">
        <ac:parameter ac:name="title">Mermaid Diagram Source</ac:parameter>
        <ac:rich-text-body>
          <ac:structured-macro ac:name="code">
            <ac:plain-text-body><![CDATA[${source}]]></ac:plain-text-body>
          </ac:structured-macro>
        </ac:rich-text-body>
      </ac:structured-macro>
      <p>After</p>
    `;
    const md = storageToMarkdownBlocks(storageHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph LR');
    expect(md).toContain('X --> Y');
    expect(md).toContain('```');
    expect(md).not.toContain('mermaid.ink');
  });

  it('reconstructs mermaid from legacy comment + image format', () => {
    const source = 'graph LR\n    X --> Y';
    const encoded = Buffer.from(source).toString('base64');
    const storageHtml = `
      <p>Intro</p>
      <!-- mermaid:${encoded} -->
      <ac:image ac:align="center" ac:width="800">
        <ac:parameter ac:name="width">800</ac:parameter>
        <ri:url ri:value="https://mermaid.ink/img/base64:${encoded}"/>
      </ac:image>
      <p>After</p>
    `;
    const md = storageToMarkdownBlocks(storageHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph LR');
    expect(md).toContain('X --> Y');
  });

  it('round-trips mermaid diagrams without data loss', () => {
    const original =
      '```mermaid\nsequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hi\n```';
    const html = markdownToStorageHtml(original);

    expect(html).toContain('mermaid.ink');
    expect(html).toContain('ac:name="expand"');
    expect(html).toContain('Mermaid Diagram Source');

    const md = storageToMarkdownBlocks(`<div>${html}</div>`)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('```mermaid');
    expect(md).toContain('sequenceDiagram');
    expect(md).toContain('Alice->>Bob: Hello');
    expect(md).toContain('Bob-->>Alice: Hi');
  });

  it('reconstructs mermaid from standalone expand macro (image stripped)', () => {
    const source = 'graph TD\n    A --> B';
    const storageHtml = `
      <div>
      <ac:structured-macro ac:name="expand">
        <ac:parameter ac:name="title">Mermaid Diagram Source</ac:parameter>
        <ac:rich-text-body>
          <ac:structured-macro ac:name="code">
            <ac:plain-text-body><![CDATA[${source}]]></ac:plain-text-body>
          </ac:structured-macro>
        </ac:rich-text-body>
      </ac:structured-macro>
      </div>
    `;
    const md = storageToMarkdownBlocks(storageHtml)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('```mermaid');
    expect(md).toContain('graph TD');
    expect(md).toContain('A --> B');
  });
});

describe('inline comment wrapper round-trip', () => {
  it('wraps commented ranges in markdown on download', () => {
    const html = `
      <p>
        <ac:structured-macro ac:name="inline-comment-marker">
          <ac:parameter ac:name="ref">cmt-123</ac:parameter>
        </ac:structured-macro>
        Hello
        <ac:structured-macro ac:name="inline-comment-marker">
          <ac:parameter ac:name="ref">cmt-123</ac:parameter>
          <ac:parameter ac:name="end">true</ac:parameter>
        </ac:structured-macro>
      </p>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown.trim())
      .join('\n');
    expect(md).toContain('<!-- comment:cmt-123 -->');
    expect(md).toContain('Hello');
    expect(md).toContain('<!-- commend-end:cmt-123 -->');
  });

  it('reconstructs inline comment markers on upload', () => {
    const md = `This is <!-- comment:cmt-42 -->important<!-- commend-end:cmt-42 --> text.`;
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:inline-comment-marker');
    expect(html).toContain('ac:ref="cmt-42"');
    expect(html).toContain('>important<');
  });
});

describe('nREQ rejected requirement rows', () => {
  it('uploads nREQ row with all cells struck through and REQ token', () => {
    const md = [
      '| ID | Description | Priority |',
      '| --- | --- | --- |',
      '| REQ(F1, MUST) | System shall do X | High |',
      '| nREQ(F2, SHOULD) | System shall do Y | Medium |',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    // REQ row: no strikethrough
    expect(html).toContain('<td><p>REQ(F1, MUST)</p></td>');
    // nREQ row: every cell wrapped in <s>, token converted back to REQ
    expect(html).toContain('<td><p><s>REQ(F2, SHOULD)</s></p></td>');
    expect(html).toContain('<td><p><s>System shall do Y</s></p></td>');
    expect(html).toContain('<td><p><s>Medium</s></p></td>');
    // nREQ itself must not appear in storage
    expect(html).not.toContain('nREQ');
  });

  it('downloads struck-through REQ cell as nREQ', () => {
    const html = `
      <table>
        <thead>
          <tr><th>ID</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><p>REQ(F1, MUST)</p></td>
            <td><p>Normal requirement</p></td>
          </tr>
          <tr>
            <td><p><s>REQ(F2, SHOULD)</s></p></td>
            <td><p><s>Rejected requirement</s></p></td>
          </tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html).map((b) => b.markdown).join('\n');
    expect(md).toContain('| REQ(F1, MUST) |');
    expect(md).toContain('| nREQ(F2, SHOULD) |');
    // The non-REQ struck-through cell should come through as plain text
    expect(md).toContain('Rejected requirement');
  });

  it('round-trips nREQ through storage HTML without data loss', () => {
    const original = [
      '| ID | Description |',
      '| --- | --- |',
      '| REQ(F1, MUST) | Active requirement |',
      '| nREQ(F2, SHOULD) | Rejected requirement |',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    const md = storageToMarkdownBlocks(`<div>${html}</div>`)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('| REQ(F1, MUST) |');
    expect(md).toContain('| nREQ(F2, SHOULD) |');
    expect(md).toContain('Active requirement');
    expect(md).toContain('Rejected requirement');
  });
});

describe('req-table Confluence round-trip', () => {
  it('emits a req-table expand macro so the marker survives Confluence stripping data-* attrs', () => {
    const md = [
      '- REQ(F1, MUST): The system MUST support auth.',
      '- nREQ(F2, SHOULD): SSO SHOULD be supported.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="expand">');
    expect(html).toContain('<ac:parameter ac:name="title">req-table</ac:parameter>');
  });

  it('round-trips a req-list after Confluence strips data-req-table attribute', () => {
    const original = [
      '- REQ(F1, MUST): The system MUST support auth.',
      '- nREQ(F2, SHOULD): SSO SHOULD be supported.',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    // Simulate Confluence stripping the data-req-table attribute
    const stripped = html.replace(/\s+data-req-table="true"/, '');
    expect(stripped).not.toContain('data-req-table');
    const md = storageToMarkdownBlocks(stripped)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('- REQ(F1, MUST):');
    expect(md).toContain('- nREQ(F2, SHOULD):');
  });
});

describe('definition lists (deflist)', () => {
  it('uploads a deflist comment + bullet items as a Confluence table', () => {
    const md = [
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
      '- ROLE(Owner/Writer): Tobias S. Keller',
      '- ROLE(Technical Reviewer): ',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain(
      '<table data-deflist="true" data-deflist-keyword="ROLE" data-deflist-columns="Role,Name">',
    );
    expect(html).toContain('<col style="width: 200px;"');
    expect(html).toContain('<col style="width: 500px;"');
    expect(html).toContain('<th><p>Role</p></th>');
    expect(html).toContain('<th><p>Name</p></th>');
    expect(html).toContain('<td><p>Owner/Writer</p></td>');
    expect(html).toContain('<td><p>Tobias S. Keller</p></td>');
    expect(html).toContain('<td><p>Technical Reviewer</p></td><td></td>');
  });

  it('supports multi-line values via indented continuation lines', () => {
    const md = [
      '<!-- deflist keyword="TERM" columns=Term,Definition -->',
      '- TERM(Facade): A design pattern serving as a front-facing interface',
      '  masking more complex underlying code.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-deflist="true"');
    expect(html).toContain('<td><p>Facade</p></td>');
    expect(html).toContain('front-facing interface<br/>masking more complex');
  });

  it('downloads a deflist table back to comment + bullet list', () => {
    const html = `
      <table data-deflist="true" data-deflist-keyword="ROLE" data-deflist-columns="Role,Name">
        <colgroup><col style="width: 200px;" /><col style="width: 500px;" /></colgroup>
        <thead><tr><th><p>Role</p></th><th><p>Name</p></th></tr></thead>
        <tbody>
          <tr><td><p>Owner/Writer</p></td><td><p>Tobias S. Keller</p></td></tr>
          <tr><td><p>Technical Reviewer</p></td><td></td></tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain(
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
    );
    expect(md).toContain('- ROLE(Owner/Writer): Tobias S. Keller');
    expect(md).toContain('- ROLE(Technical Reviewer):');
    // No trailing space after the colon when the value is empty.
    expect(md).not.toMatch(/ROLE\(Technical Reviewer\): \n/);
  });

  it('preserves multi-line values through download', () => {
    const html = `
      <table data-deflist="true" data-deflist-keyword="TERM" data-deflist-columns="Term,Definition">
        <tbody>
          <tr>
            <td><p>Facade</p></td>
            <td><p>A design pattern serving as a front-facing interface<br/>masking more complex underlying code.</p></td>
          </tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain(
      '<!-- deflist keyword="TERM" columns=Term,Definition -->',
    );
    expect(md).toContain(
      '- TERM(Facade): A design pattern serving as a front-facing interface',
    );
    expect(md).toContain('  masking more complex underlying code.');
  });

  it('round-trips a deflist through storage HTML without data loss', () => {
    const original = [
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
      '- ROLE(Owner/Writer): Tobias S. Keller',
      '- ROLE(Product Manager):',
      '- ROLE(Technical Reviewer):',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    const md = storageToMarkdownBlocks(`<div>${html}</div>`)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain(
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
    );
    expect(md).toContain('- ROLE(Owner/Writer): Tobias S. Keller');
    expect(md).toContain('- ROLE(Product Manager):');
    expect(md).toContain('- ROLE(Technical Reviewer):');
  });

  it('supports quoted column names containing spaces', () => {
    const md = [
      '<!-- deflist keyword="FIELD" columns="Field Name,Value" -->',
      '- FIELD(Project): Confluence Tools',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-deflist-columns="Field Name,Value"');
    expect(html).toContain('<th><p>Field Name</p></th>');
    expect(html).toContain('<th><p>Value</p></th>');
  });

  it('falls back to a bullet list when the deflist comment lacks a keyword', () => {
    const md = [
      '<!-- deflist columns=A,B -->',
      '- NOTE(x): y',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    // Without a keyword, the comment is ignored and the bullet is rendered
    // as a normal list item. The custom table marker must not appear.
    expect(html).not.toContain('data-deflist');
  });

  it('does not swallow unrelated content after a deflist block', () => {
    const md = [
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
      '- ROLE(Owner): Alice',
      '',
      '## Next section',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-deflist="true"');
    expect(html).toContain('<h2>Next section</h2>');
  });

  it('emits a deflist-config expand macro so the config survives Confluence stripping data-* attrs', () => {
    const md = [
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
      '- ROLE(Owner): Alice',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="expand">');
    expect(html).toContain('<ac:parameter ac:name="title">deflist-config</ac:parameter>');
    expect(html).toContain('<p>ROLE:Role,Name</p>');
  });

  it('round-trips after Confluence strips data-* attributes (via expand macro)', () => {
    const original = [
      '<!-- deflist keyword="ROLE" columns=Role,Name -->',
      '- ROLE(Owner/Writer): Tobias S. Keller',
      '- ROLE(Product Manager):',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    // Simulate Confluence stripping the data-* attributes from the table tag
    const stripped = html
      .replace(/\s+data-deflist="true"/, '')
      .replace(/\s+data-deflist-keyword="[^"]*"/, '')
      .replace(/\s+data-deflist-columns="[^"]*"/, '');
    expect(stripped).not.toContain('data-deflist');
    const md = storageToMarkdownBlocks(stripped)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- deflist keyword="ROLE" columns=Role,Name -->');
    expect(md).toContain('- ROLE(Owner/Writer): Tobias S. Keller');
    expect(md).toContain('- ROLE(Product Manager):');
  });

  it('handles markdown links in keys (link contains closing paren)', () => {
    const md = [
      '<!-- deflist keyword="Doc" columns=Document,Relevance -->',
      '- Doc([TDD - Care Independence Strategy](pageid:E:5292327446)): Previous strategy doc.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    // Key cell should contain a Confluence page link, not literal bracket text
    expect(html).toContain('<ac:link>');
    expect(html).toContain('TDD - Care Independence Strategy');
    // Round-trip
    const md2 = storageToMarkdownBlocks(html).map((b) => b.markdown).join('\n');
    expect(md2).toContain('<!-- deflist keyword="Doc" columns=Document,Relevance -->');
    expect(md2).toContain('[TDD - Care Independence Strategy](');
    expect(md2).toContain('Previous strategy doc.');
  });

  it('is not confused when the value also contains ):', () => {
    const md = [
      '<!-- deflist keyword="Doc" columns=Document,Relevance -->',
      '- Doc(Key): Value with ): tricky text.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<p>Key</p>');
    expect(html).toContain('Value with ): tricky text.');
  });

  it('handles keys containing inner parentheses like (SN, 2026)', () => {
    const md = [
      '<!-- deflist keyword="Doc" columns=Document,Relevance -->',
      '- Doc(EPOS Gateway - System Overview (SN, 2026)): Updated 2026 mirror.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('EPOS Gateway - System Overview (SN, 2026)');
    const md2 = storageToMarkdownBlocks(html).map((b) => b.markdown).join('\n');
    expect(md2).toContain('- Doc(EPOS Gateway - System Overview (SN, 2026)): Updated 2026 mirror.');
  });

  it('does not double-encode HTML entities in keys (&amp; stays as & on the page)', () => {
    const md = [
      '<!-- deflist keyword="Doc" columns=Document,Relevance -->',
      '- Doc(Overview &amp; Guide): Description.',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    // Should be &amp; in storage (displays as & on Confluence), NOT &amp;amp;
    expect(html).toContain('Overview &amp; Guide');
    expect(html).not.toContain('&amp;amp;');
  });

  it('round-trips quoted column names with spaces after Confluence strips data-* attributes', () => {
    const original = [
      '<!-- deflist keyword="FIELD" columns="Field Name,Value" -->',
      '- FIELD(Project): Confluence Tools',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    const stripped = html
      .replace(/\s+data-deflist="true"/, '')
      .replace(/\s+data-deflist-keyword="[^"]*"/, '')
      .replace(/\s+data-deflist-columns="[^"]*"/, '');
    const md = storageToMarkdownBlocks(stripped)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- deflist keyword="FIELD" columns="Field Name,Value" -->');
    expect(md).toContain('- FIELD(Project): Confluence Tools');
  });
});

describe('list tables', () => {
  it('uploads a list-table comment + rows as a Confluence table', () => {
    const md = [
      '<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit",characteristics:"Characteristics",amountStudents:"Amount Students" spacing=1,2,2,5 -->',
      'programFamily: FS',
      'businessUnit: Distance Learning',
      'amountStudents: 140.000',
      'characteristics:',
      '  - Mainly Managed in EPOS',
      '  - use MyCampus',
      '  - Write online Exams',
      '',
      '---',
      '',
      'programFamily: EU',
      'businessUnit: Distance Learning',
      'amountStudents: 40.000',
      'characteristics:',
      '  - Online Students',
      '  - Mainly Managed in EPOS',
      '  - use MyCampus',
      '  - Write online Exams',
      '',
      '<!-- /list-table -->',
    ].join('\n');

    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-list-table="true"');
    expect(html).toContain('data-list-table-config="programFamily:Program Family,businessUnit:Business Unit,characteristics:Characteristics,amountStudents:Amount Students"');
    expect(html).toContain('data-list-table-spacing="1,2,2,5"');
    expect(html).toContain('<th><p>Program Family</p></th>');
    expect(html).toContain('<th><p>Business Unit</p></th>');
    expect(html).toContain('<th><p>Characteristics</p></th>');
    expect(html).toContain('<th><p>Amount Students</p></th>');
    expect(html).toContain('<td><p>FS</p></td>');
    expect(html).toContain('<td><p>Distance Learning</p></td>');
    expect(html).toContain('<td><ul><li><p>Mainly Managed in EPOS</p></li>');
    expect(html).toContain('<td><p>EU</p></td>');
    expect(html).toContain('<td><p>40.000</p></td>');
  });

  it('downloads a list-table back to comment + key-value rows', () => {
    const html = `
      <table data-list-table="true" data-list-table-config="programFamily:Program Family,businessUnit:Business Unit,characteristics:Characteristics,amountStudents:Amount Students" data-list-table-spacing="1,2,2,5">
        <colgroup><col style="width: 100px;" /><col style="width: 200px;" /><col style="width: 200px;" /><col style="width: 500px;" /></colgroup>
        <thead><tr><th><p>Program Family</p></th><th><p>Business Unit</p></th><th><p>Characteristics</p></th><th><p>Amount Students</p></th></tr></thead>
        <tbody>
          <tr><td><p>FS</p></td><td><p>Distance Learning</p></td><td><ul><li><p>Mainly Managed in EPOS</p></li><li><p>use MyCampus</p></li><li><p>Write online Exams</p></li></ul></td><td><p>140.000</p></td></tr>
          <tr><td><p>EU</p></td><td><p>Distance Learning</p></td><td><ul><li><p>Online Students</p></li><li><p>Mainly Managed in EPOS</p></li><li><p>use MyCampus</p></li><li><p>Write online Exams</p></li></ul></td><td><p>40.000</p></td></tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit",characteristics:"Characteristics",amountStudents:"Amount Students" spacing=1,2,2,5 -->');
    expect(md).toContain('programFamily: FS');
    expect(md).toContain('businessUnit: Distance Learning');
    expect(md).toContain('characteristics:');
    expect(md).toContain('  - Mainly Managed in EPOS');
    expect(md).toContain('amountStudents: 140.000');
    expect(md).toContain('programFamily: EU');
    expect(md).toContain('<!-- /list-table -->');
  });

  it('round-trips a list-table through storage HTML without data loss', () => {
    const original = [
      '<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit" -->',
      'programFamily: FS',
      'businessUnit: Distance Learning',
      '',
      '---',
      '',
      'programFamily: EU',
      'businessUnit: Distance Learning',
      '',
      '<!-- /list-table -->',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    const md = storageToMarkdownBlocks(`<div>${html}</div>`)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit" -->');
    expect(md).toContain('programFamily: FS');
    expect(md).toContain('businessUnit: Distance Learning');
    expect(md).toContain('programFamily: EU');
    expect(md).toContain('<!-- /list-table -->');
  });

  it('supports merge directives for merged cells', () => {
    const md = [
      '<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit",characteristics:"Characteristics",amountStudents:"Amount Students" -->',
      'merge(programFamily,businessUnit,amountStudents,characteristics)',
      '',
      'businessUnit: Distance Learning',
      '',
      '---',
      '',
      'programFamily: FS',
      'businessUnit: Distance Learning',
      'amountStudents: 140.000',
      'characteristics:',
      '  - Mainly Managed in EPOS',
      '',
      '<!-- /list-table -->',
    ].join('\n');

    const html = markdownToStorageHtml(md);
    expect(html).toContain('colspan="4"');
    expect(html).toContain('data-list-table-merge="programFamily,businessUnit,amountStudents,characteristics"');
    expect(html).toContain('<td colspan="4"><p>Distance Learning</p></td>');
  });

  it('downloads merged list-table rows back to merge directives', () => {
    const html = `
      <table data-list-table="true" data-list-table-config="programFamily:Program Family,businessUnit:Business Unit,characteristics:Characteristics,amountStudents:Amount Students">
        <thead><tr><th><p>Program Family</p></th><th><p>Business Unit</p></th><th><p>Characteristics</p></th><th><p>Amount Students</p></th></tr></thead>
        <tbody>
          <tr data-list-table-merge="programFamily,businessUnit,amountStudents,characteristics">
            <td colspan="4"><p>Distance Learning</p></td>
          </tr>
          <tr><td><p>FS</p></td><td><p>Distance Learning</p></td><td><p>Managed in EPOS</p></td><td><p>140.000</p></td></tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('merge(programFamily, businessUnit, amountStudents, characteristics)');
    expect(md).toContain('programFamily: Distance Learning');
    expect(md).toContain('programFamily: FS');
  });

  it('supports multiple merge groups in a single row', () => {
    const md = [
      '<!-- list-table columns=unit:"Unit",family:"Program Family",desc:"Description",pattern:"Identification Pattern",systems:"Managing Systems" spacing=1,1,4,2,2 -->',
      'merge(unit, family)',
      'merge(desc, pattern, systems)',
      '',
      'unit: Distance Learning (Online DACH)',
      'desc: Distance Learning. Take online exams in Pebblepad, Turnitin, eAssassment; Self-Enrol into classes. Fixed scripts.',
      '',
      '---',
      '',
      'family: FS',
      'pattern: Starting with `FS` and not including `OI`',
      'systems: ~80% Managed in EPOS, some still in CARE, MyCampus, Syntea, CuMo 1 + PIM',
      'desc: For students residing in germany',
      '',
      '<!-- /list-table -->',
    ].join('\n');

    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-list-table-merge="unit,family|desc,pattern,systems"');
    expect(html).toContain('<td colspan="2"><p>Distance Learning (Online DACH)</p></td>');
    expect(html).toContain('<td colspan="3"><p>Distance Learning. Take online exams in Pebblepad, Turnitin, eAssassment; Self-Enrol into classes. Fixed scripts.</p></td>');
  });

  it('downloads multiple merge groups back to separate merge directives', () => {
    const html = `
      <table data-list-table="true" data-list-table-config="unit:Unit,family:Program Family,desc:Description,pattern:Identification Pattern,systems:Managing Systems">
        <thead><tr><th><p>Unit</p></th><th><p>Program Family</p></th><th><p>Description</p></th><th><p>Identification Pattern</p></th><th><p>Managing Systems</p></th></tr></thead>
        <tbody>
          <tr data-list-table-merge="unit,family|desc,pattern,systems">
            <td colspan="2"><p>Distance Learning (Online DACH)</p></td>
            <td colspan="3"><p>Distance Learning. Take online exams in Pebblepad, Turnitin, eAssassment; Self-Enrol into classes. Fixed scripts.</p></td>
          </tr>
          <tr><td></td><td><p>FS</p></td><td><p>For students residing in germany</p></td><td><p>Standard FS programs</p></td><td><p>Managed in EPOS</p></td></tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('merge(unit, family)');
    expect(md).toContain('merge(desc, pattern, systems)');
    expect(md).toContain('unit: Distance Learning (Online DACH)');
    expect(md).toContain('desc: Distance Learning. Take online exams');
    expect(md).toContain('family: FS');
  });

  it('infers merge directives from colspan when data-list-table-merge is absent', () => {
    // Simulates a table that was edited in Confluence UI and lost our
    // custom data attribute but still carries colspan on merged cells.
    const html = `
      <table data-list-table="true" data-list-table-config="programFamily:Program Family,businessUnit:Business Unit,characteristics:Characteristics,amountStudents:Amount Students">
        <thead><tr><th><p>Program Family</p></th><th><p>Business Unit</p></th><th><p>Characteristics</p></th><th><p>Amount Students</p></th></tr></thead>
        <tbody>
          <tr>
            <td colspan="4"><p>Distance Learning</p></td>
          </tr>
          <tr><td><p>FS</p></td><td><p>Distance Learning</p></td><td><p>Managed in EPOS</p></td><td><p>140.000</p></td></tr>
        </tbody>
      </table>
    `;
    const md = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('merge(programFamily, businessUnit, characteristics, amountStudents)');
    expect(md).toContain('programFamily: Distance Learning');
    expect(md).toContain('programFamily: FS');
  });

  it('emits a list-table-config expand macro for round-trip survival', () => {
    const md = [
      '<!-- list-table columns=a:"A" -->',
      'a: 1',
      '<!-- /list-table -->',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="expand">');
    expect(html).toContain('<ac:parameter ac:name="title">list-table-config</ac:parameter>');
  });

  it('round-trips after Confluence strips data-* attributes (via expand macro)', () => {
    const original = [
      '<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit" -->',
      'programFamily: FS',
      'businessUnit: Distance Learning',
      '',
      '---',
      '',
      'programFamily: EU',
      'businessUnit: Distance Learning',
      '',
      '<!-- /list-table -->',
    ].join('\n');
    const html = markdownToStorageHtml(original);
    const stripped = html
      .replace(/\s+data-list-table="true"/, '')
      .replace(/\s+data-list-table-config="[^"]*"/, '')
      .replace(/\s+data-list-table-spacing="[^"]*"/, '');
    expect(stripped).not.toContain('data-list-table');
    const md = storageToMarkdownBlocks(stripped)
      .map((b) => b.markdown)
      .join('\n');
    expect(md).toContain('<!-- list-table columns=programFamily:"Program Family",businessUnit:"Business Unit" -->');
    expect(md).toContain('programFamily: FS');
    expect(md).toContain('businessUnit: Distance Learning');
    expect(md).toContain('programFamily: EU');
    expect(md).toContain('<!-- /list-table -->');
  });

  it('supports multi-line values via indented continuation lines', () => {
    const md = [
      '<!-- list-table columns=field:"Field",value:"Value" -->',
      'field: Name',
      'value: First line',
      '  second line',
      '  third line',
      '',
      '<!-- /list-table -->',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('First line<br/>second line<br/>third line');
  });

  it('does not swallow unrelated content after a list-table block', () => {
    const md = [
      '<!-- list-table columns=a:"A" -->',
      'a: 1',
      '<!-- /list-table -->',
      '',
      '## Next section',
    ].join('\n');
    const html = markdownToStorageHtml(md);
    expect(html).toContain('data-list-table="true"');
    expect(html).toContain('<h2>Next section</h2>');
  });

  it('preserves blank lines within multi-paragraph cell values as paragraph breaks', () => {
    const md = [
      '<!-- list-table columns=family:"Family",desc:"Description" -->',
      'family: OI/ EM',
      'desc: For non EU students/ Emerging Markets (=EM).',
      '',
      'Formerly called FI (Fernstudium International)',
      '',
      '---',
      '',
      'family: FS',
      'desc: For students residing in germany',
      '',
      '<!-- /list-table -->',
    ].join('\n');

    const html = markdownToStorageHtml(md);
    // Should be exactly 2 data rows (merge row + OI row + FS row = 3 total)
    const tbodyMatch = html.match(/<tbody>(.*?)<\/tbody>/s);
    const rows = tbodyMatch?.[1]
      ? tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/g) || []
      : [];
    expect(rows.length).toBe(2);

    // The desc cell should contain a paragraph break (<br/><br/>)
    expect(html).toContain(
      'For non EU students/ Emerging Markets (=EM).<br/><br/>Formerly called FI (Fernstudium International)',
    );

    // Download should preserve the value on a single row
    const md2 = storageToMarkdownBlocks(html)
      .map((b) => b.markdown)
      .join('\n');
    expect(md2).toContain('family: OI/ EM');
    expect(md2).toContain('desc: For non EU students/ Emerging Markets (=EM).');
    expect(md2).toContain('Formerly called FI (Fernstudium International)');
    // Should NOT create an extra row for the continuation text
    const oiOccurrences = md2.split('family: OI/ EM').length - 1;
    expect(oiOccurrences).toBe(1);
  });
});

describe('detectUnsupportedFeatures', () => {
  it('detects multi-column layouts (section/column macros)', () => {
    const html = `
      <ac:structured-macro ac:name="section">
        <ac:rich-text-body>
          <ac:structured-macro ac:name="column">
            <ac:rich-text-body><p>Column 1</p></ac:rich-text-body>
          </ac:structured-macro>
          <ac:structured-macro ac:name="column">
            <ac:rich-text-body><p>Column 2</p></ac:rich-text-body>
          </ac:structured-macro>
        </ac:rich-text-body>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('multi-column layout');
  });

  it('detects page layouts', () => {
    const html = `<ac:layout><ac:layout-section><ac:layout-cell></ac:layout-cell></ac:layout-section></ac:layout>`;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('page layout');
  });

  it('detects expand macros', () => {
    const html = `
      <ac:structured-macro ac:name="expand">
        <ac:parameter ac:name="title">Click to expand</ac:parameter>
        <ac:rich-text-body><p>Hidden content</p></ac:rich-text-body>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('expand/collapse sections');
  });

  it('does not flag mermaid expand macros as unsupported', () => {
    const html = `
      <ac:image ac:align="center" ac:width="800">
        <ri:url ri:value="https://mermaid.ink/img/pako:abc123"/>
      </ac:image>
      <ac:structured-macro ac:name="expand">
        <ac:parameter ac:name="title">Mermaid Diagram Source</ac:parameter>
        <ac:rich-text-body>
          <ac:structured-macro ac:name="code">
            <ac:plain-text-body><![CDATA[graph TD\n    A --> B]]></ac:plain-text-body>
          </ac:structured-macro>
        </ac:rich-text-body>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).not.toContain('expand/collapse sections');
  });

  it('does not flag Jira issue macros as unsupported (they round-trip)', () => {
    const html = `
      <ac:structured-macro ac:name="jira">
        <ac:parameter ac:name="key">PROJ-123</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).not.toContain('Jira issue integration');
  });

  it('detects merged table cells (colspan)', () => {
    const html = `
      <table>
        <tr>
          <th colspan="2">Merged Header</th>
        </tr>
        <tr>
          <td>A</td><td>B</td>
        </tr>
      </table>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('merged table cells');
  });

  it('detects merged table cells (rowspan)', () => {
    const html = `
      <table>
        <tr>
          <td rowspan="3">Merged</td>
          <td>A</td>
        </tr>
        <tr><td>B</td></tr>
        <tr><td>C</td></tr>
      </table>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('merged table cells');
  });

  it('does not flag merged cells in list-tables as unsupported', () => {
    const html = `
      <table data-list-table="true" data-list-table-config="a:A,b:B">
        <tr><td colspan="2"><p>Merged</p></td></tr>
        <tr><td><p>A</p></td><td><p>B</p></td></tr>
      </table>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).not.toContain('merged table cells');
  });

  it('detects chart and diagram macros', () => {
    const html = `
      <ac:structured-macro ac:name="drawio">
        <ac:parameter ac:name="diagramName">Architecture</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('charts/diagrams');
  });

  it('detects page tree macros', () => {
    const html = `
      <ac:structured-macro ac:name="pagetree">
        <ac:parameter ac:name="root">@self</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('page tree/children display');
  });

  it('detects include page macros', () => {
    const html = `
      <ac:structured-macro ac:name="include">
        <ac:parameter ac:name="pageTitle">Another Page</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('page include');
  });

  it('detects excerpt macros', () => {
    const html = `
      <ac:structured-macro ac:name="excerpt">
        <ac:rich-text-body><p>This is an excerpt</p></ac:rich-text-body>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('excerpt macros');
  });

  it('detects iframe and widget macros', () => {
    const html = `
      <ac:structured-macro ac:name="iframe">
        <ac:parameter ac:name="url">https://example.com</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('embedded iframe/widget/HTML');
  });

  it('detects roadmap macros', () => {
    const html = `
      <ac:structured-macro ac:name="roadmap">
        <ac:parameter ac:name="title">Project Roadmap</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('roadmap/timeline');
  });

  it('detects attachments list macros', () => {
    const html = `
      <ac:structured-macro ac:name="attachments">
        <ac:parameter ac:name="old">false</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('attachments list');
  });

  it('detects dynamic content display macros', () => {
    const html = `
      <ac:structured-macro ac:name="contentbylabel">
        <ac:parameter ac:name="label">important</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain('dynamic content display');
  });

  it('returns empty array for documents with only supported features', () => {
    const html = `
      <h1>Title</h1>
      <p>Some text with <strong>bold</strong> and <code>code</code>.</p>
      <table>
        <tr><th>Header</th></tr>
        <tr><td>Data</td></tr>
      </table>
      <ac:structured-macro ac:name="toc"></ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toHaveLength(0);
  });

  it('detects multiple unsupported features in one document', () => {
    const html = `
      <ac:structured-macro ac:name="section">
        <ac:rich-text-body>
          <ac:structured-macro ac:name="column">
            <ac:rich-text-body>
              <ac:structured-macro ac:name="include">
                <ac:parameter ac:name="pageTitle">Other</ac:parameter>
              </ac:structured-macro>
            </ac:rich-text-body>
          </ac:structured-macro>
        </ac:rich-text-body>
      </ac:structured-macro>
      <table>
        <tr><th colspan="2">Merged</th></tr>
        <tr><td>A</td><td>B</td></tr>
      </table>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported.length).toBeGreaterThan(1);
    expect(unsupported).toContain('multi-column layout');
    expect(unsupported).toContain('page include');
    expect(unsupported).toContain('merged table cells');
  });
});
