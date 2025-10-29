import { describe, it, expect } from "vitest";
import { storageToMarkdownBlocks, markdownToStorageHtml, detectUnsupportedFeatures } from "../storage-dom.js";

describe("storageToMarkdownBlocks", () => {
  it("renders TOC macro as placeholder comment", () => {
    const html = `
      <ac:structured-macro ac:name="toc"></ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    // eslint-disable-next-line no-console
    console.log("TABLE_OUT:\n" + out);
    expect(out).toContain("<!-- widget:TOC -->");
  });

  it("renders GFM table with inline comments preserved", () => {
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
    const out = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(out).toContain("| Title 1 | Title 2 | Title 3 |");
    expect(out).toContain("| --- | --- | --- |");
    expect(out).toContain("<!-- table:bg:red -->");
    expect(out).toContain("<!-- table:bg:green -->");
    expect(out).toContain("<!-- table:bg:blue -->");
  });

  it("converts Confluence code macro to fenced code block with language", () => {
    const html = `
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">typescript</ac:parameter>
        <ac:plain-text-body><![CDATA[const x: number = 1;\nconsole.log(x);]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(out).toContain("```typescript\nconst x: number = 1;\nconsole.log(x);\n```");
  });

  it("decodes MD_CODE token into fenced JSON with original content intact", () => {
    const jsonSnippet = [
      "// .cursor/mcp.json or ~/.cursor/mcp.json",
      "{",
      "  \"mcpServers\": {",
      "    \"mcp-atlassian\": {",
      "      \"command\": \"docker\",",
      "      \"args\": [\"run\", \"-i\", \"--rm\"],",
      "      \"env\": {}",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const html = `
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">json</ac:parameter>
        <ac:plain-text-body><![CDATA[${jsonSnippet}]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(out).toContain("```json\n// .cursor/mcp.json or ~/.cursor/mcp.json");
    expect(out).toContain("\n}\n```");
  });

  it("converts fenced code block back to Confluence code macro with language", () => {
    const md = [
      "```bash",
      "echo hello",
      "```",
      "",
      "```",
      "no-lang fence",
      "```",
    ].join("\n");
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="code">');
    expect(html).toContain('<ac:parameter ac:name="language">bash</ac:parameter>');
    expect(html).toContain('<ac:plain-text-body><![CDATA[echo hello]]></ac:plain-text-body>');
    expect(html).toContain('<ac:plain-text-body><![CDATA[no-lang fence]]></ac:plain-text-body>');
  });

  it("preserves raw text when CDATA would be broken by ]]>", () => {
    const md = [
      "```",
      "end of cdata ]]> should be escaped",
      "```",
    ].join("\n");
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="code">');
    expect(html).toContain('<ac:plain-text-body>');
    expect(html).toContain('end of cdata ]&gt; should be escaped');
  });

  it("converts Confluence code macro to fenced code block", () => {
    const html = `
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">json</ac:parameter>
        <ac:plain-text-body><![CDATA[line1\nline2]]></ac:plain-text-body>
      </ac:structured-macro>
    `;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    // Expect fenced block
    expect(out).toContain("```\nline1\nline2\n```");
  });

  it("parses indented code blocks back to code macro", () => {
    const md = [
      "    const a = 1;",
      "    console.log(a);",
      "",
      "Not code",
    ].join("\n");
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="code">');
    expect(html).toContain('<ac:plain-text-body><![CDATA[const a = 1\nconsole.log(a);]]></ac:plain-text-body>');
  });

  it("converts unordered lists and inline formatting", () => {
    const md = [
      "**bold** and `code` in a paragraph.",
      "",
      "- Item 1",
      "- Item 2",
    ].join("\n");
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<p><strong>bold</strong> and <code>code</code> in a paragraph.</p>');
    expect(html).toContain('<ul><li>Item 1</li><li>Item 2</li></ul>');
  });

  it("decodes literal \\n in table cell markdown back to <br/> on upload", () => {
    const md = [
      "| Col |",
      "| --- |",
      "| line1\\nline2 |",
    ].join("\n");
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>line1<br/>line2</td>');
  });

  it("converts links, mention tags, and blockquotes on upload", () => {
    const md = [
      "> <!-- panel:info:info -->",
      "> **Bold** text with a [link](https://example.com) and <!-- mention:acc-123 User Name -->",
      "",
      "> normal block quote line",
    ].join("\n");
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:structured-macro ac:name="info">');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain('<ac:atlassian-user ac:account-id="acc-123"/>' );
  });

  it("does not escape underscores in download outside code", () => {
    const html = `
      <p>Env: CONFLUENCE_API_TOKEN and CONFLUENCE_USERNAME</p>
    `;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(out).toContain("CONFLUENCE_API_TOKEN");
    expect(out).toContain("CONFLUENCE_USERNAME");
    expect(out).not.toContain("\\_");
  });

  it("does not escape underscores in plain text nodes", () => {
    const html = `Text with CONST_VAR and another_VAR`;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(out).toContain("CONST_VAR");
    expect(out).toContain("another_VAR");
    expect(out).not.toContain("CONST\\_VAR");
  });

  it("collapses double-escaped underscores to single escaped underscore", () => {
    const html = `<p>double: \\_ should normalize</p>`;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(out).toContain("\\_");
  });

  it("preserves status inline tag round-trip", () => {
    const html = `
      <ac:structured-macro ac:name="status">
        <ac:parameter ac:name="title">In Progress</ac:parameter>
        <ac:parameter ac:name="colour">Yellow</ac:parameter>
      </ac:structured-macro>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("<!-- status:yellow:In Progress -->");
    const back = markdownToStorageHtml(md);
    expect(back).toContain('<ac:structured-macro ac:name="status">');
    expect(back).toContain('<ac:parameter ac:name="title">In Progress</ac:parameter>');
    expect(back).toContain('<ac:parameter ac:name="colour">yellow</ac:parameter>');
  });

  it("preserves mention round-trip using mention tag", () => {
    const html = `
      <ac:link><ri:user ri:account-id="abc-123" /></ac:link>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("<!-- mention:abc-123 ");
    const back = markdownToStorageHtml(md + "\n");
    expect(back).toContain('<ac:atlassian-user ac:account-id="abc-123"/>' );
  });

  it("converts Confluence image with caption to markdown image + caption and back", () => {
    const html = `
      <ac:image>
        <ri:url ri:value="https://example.com/img.png" />
        <ac:caption>Figure 1: Example</ac:caption>
      </ac:image>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("![](" );
    expect(md).toContain("https://example.com/img.png");
    expect(md).toContain("Figure 1: Example");
    const back = markdownToStorageHtml(md);
    expect(back).toContain('<ac:image>');
    expect(back).toContain('<ri:url ri:value="https://example.com/img.png"/>');
    expect(back).toContain('<ac:caption>Figure 1: Example</ac:caption>');
  });

  it("panel macro downloads as blockquote with config tag and uploads back", () => {
    const html = `
      <ac:structured-macro ac:name="info">
        <ac:rich-text-body>
          <p>Be aware of this.</p>
        </ac:rich-text-body>
      </ac:structured-macro>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(md).toContain("> <!-- panel:info:info -->");
    expect(md).toContain("> Be aware of this.");
    const back = markdownToStorageHtml(md);
    expect(back).toContain('<ac:structured-macro ac:name="info">');
    expect(back).toContain('<ac:rich-text-body>');
  });

  it("encodes newlines in table cells as \\n in markdown", () => {
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
    const md = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(md).toContain("| Col |");
    expect(md).toContain("| line1\\nline2 |");
  });

  it("appends cell styling tag and preserves literal \\n in cell content", () => {
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
    const md = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    // Styled cell from table:bg
    expect(md).toContain("| first line <!-- cell:bg:#ffeeee --> |");
    // Inline newline and explicit cell:bg
    expect(md).toContain("| one\\nTwo <!-- cell:bg:yellow --> |");
  });

  it("does not escape dots in ordered lists", () => {
    const html = `
      <ol>
        <li>First</li>
        <li>Second</li>
      </ol>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown).join("\n");
    expect(md).toMatch(/\n1\. First/);
    expect(md).toMatch(/\n2\. Second/);
    expect(md).not.toContain("1\\.");
  });

  it("renders horizontal rules as dashed lines", () => {
    const html = `<hr/>`;
    const out = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(out).toBe("-------");
  });

  it("converts Confluence page links to markdown links with page: scheme", () => {
    const html = `
      <p>
        See <ac:link>
          <ri:page ri:content-title="Design Document" />
          <ac:plain-text-link-body><![CDATA[the design doc]]></ac:plain-text-link-body>
        </ac:link> for details.
      </p>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("[the design doc](page:Design Document)");
  });

  it("converts Confluence page links with space key to markdown", () => {
    const html = `
      <p>
        Check <ac:link>
          <ri:page ri:space-key="MYSPACE" ri:content-title="My Page" />
          <ac:plain-text-link-body><![CDATA[this page]]></ac:plain-text-link-body>
        </ac:link>
      </p>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("[this page](page:MYSPACE:My Page)");
  });

  it("converts Confluence attachment links to markdown with #attachment: scheme", () => {
    const html = `
      <p>
        Download <ac:link>
          <ri:attachment ri:filename="report.pdf" />
          <ac:plain-text-link-body><![CDATA[the report]]></ac:plain-text-link-body>
        </ac:link>
      </p>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("[the report](#attachment:report.pdf)");
  });

  it("converts Confluence URL links within ac:link to markdown", () => {
    const html = `
      <p>
        Visit <ac:link>
          <ri:url ri:value="https://example.com/docs" />
          <ac:plain-text-link-body><![CDATA[our docs]]></ac:plain-text-link-body>
        </ac:link>
      </p>
    `;
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("[our docs](https://example.com/docs)");
  });

  it("converts markdown page links back to Confluence storage format", () => {
    const md = "See [the design doc](page:Design Document) for details.";
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:page ri:content-title="Design Document"/>');
    expect(html).toContain('<ac:plain-text-link-body><![CDATA[the design doc]]></ac:plain-text-link-body>');
  });

  it("converts markdown page links with space key back to Confluence", () => {
    const md = "Check [this page](page:MYSPACE:My Page) out.";
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:page ri:space-key="MYSPACE" ri:content-title="My Page"/>');
    expect(html).toContain('<ac:plain-text-link-body><![CDATA[this page]]></ac:plain-text-link-body>');
  });

  it("converts markdown attachment links back to Confluence storage format", () => {
    const md = "Download [the report](#attachment:report.pdf) here.";
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:attachment ri:filename="report.pdf"/>');
    expect(html).toContain('<ac:plain-text-link-body><![CDATA[the report]]></ac:plain-text-link-body>');
  });

  it("preserves regular URL links in markdown and HTML", () => {
    const md = "Visit [our website](https://example.com) for more info.";
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<a href="https://example.com">our website</a>');
  });

  it("round-trips page links through markdown without data loss", () => {
    const originalHtml = `
      <p>
        See <ac:link>
          <ri:page ri:space-key="DEV" ri:content-title="API Reference" />
          <ac:plain-text-link-body><![CDATA[API docs]]></ac:plain-text-link-body>
        </ac:link> for details.
      </p>
    `;
    // Convert to markdown
    const md = storageToMarkdownBlocks(originalHtml).map(b => b.markdown).join("\n");
    expect(md).toContain("[API docs](page:DEV:API Reference)");
    
    // Convert back to HTML
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ri:page ri:space-key="DEV" ri:content-title="API Reference"/>');
    expect(html).toContain('<ac:plain-text-link-body><![CDATA[API docs]]></ac:plain-text-link-body>');
  });
});


describe("inline comment wrapper round-trip", () => {
  it("wraps commented ranges in markdown on download", () => {
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
    const md = storageToMarkdownBlocks(html).map(b => b.markdown.trim()).join("\n");
    expect(md).toContain("<!-- comment:cmt-123 -->");
    expect(md).toContain("Hello");
    expect(md).toContain("<!-- commend-end:cmt-123 -->");
  });

  it("reconstructs inline comment markers on upload", () => {
    const md = `This is <!-- comment:cmt-42 -->important<!-- commend-end:cmt-42 --> text.`;
    const html = markdownToStorageHtml(md);
    expect(html).toContain('<ac:inline-comment-marker');
    expect(html).toContain('ac:ref="cmt-42"');
    expect(html).toContain('>important<');
  });
});

describe("detectUnsupportedFeatures", () => {
  it("detects multi-column layouts (section/column macros)", () => {
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
    expect(unsupported).toContain("multi-column layout");
  });

  it("detects page layouts", () => {
    const html = `<ac:layout><ac:layout-section><ac:layout-cell></ac:layout-cell></ac:layout-section></ac:layout>`;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("page layout");
  });

  it("detects expand macros", () => {
    const html = `
      <ac:structured-macro ac:name="expand">
        <ac:parameter ac:name="title">Click to expand</ac:parameter>
        <ac:rich-text-body><p>Hidden content</p></ac:rich-text-body>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("expand/collapse sections");
  });

  it("detects Jira integration macros", () => {
    const html = `
      <ac:structured-macro ac:name="jira">
        <ac:parameter ac:name="key">PROJ-123</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("Jira issue integration");
  });

  it("detects merged table cells (colspan)", () => {
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
    expect(unsupported).toContain("merged table cells");
  });

  it("detects merged table cells (rowspan)", () => {
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
    expect(unsupported).toContain("merged table cells");
  });

  it("detects chart and diagram macros", () => {
    const html = `
      <ac:structured-macro ac:name="drawio">
        <ac:parameter ac:name="diagramName">Architecture</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("charts/diagrams");
  });

  it("detects page tree macros", () => {
    const html = `
      <ac:structured-macro ac:name="pagetree">
        <ac:parameter ac:name="root">@self</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("page tree/children display");
  });

  it("detects include page macros", () => {
    const html = `
      <ac:structured-macro ac:name="include">
        <ac:parameter ac:name="pageTitle">Another Page</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("page include");
  });

  it("detects excerpt macros", () => {
    const html = `
      <ac:structured-macro ac:name="excerpt">
        <ac:rich-text-body><p>This is an excerpt</p></ac:rich-text-body>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("excerpt macros");
  });

  it("detects iframe and widget macros", () => {
    const html = `
      <ac:structured-macro ac:name="iframe">
        <ac:parameter ac:name="url">https://example.com</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("embedded iframe/widget/HTML");
  });

  it("detects roadmap macros", () => {
    const html = `
      <ac:structured-macro ac:name="roadmap">
        <ac:parameter ac:name="title">Project Roadmap</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("roadmap/timeline");
  });

  it("detects attachments list macros", () => {
    const html = `
      <ac:structured-macro ac:name="attachments">
        <ac:parameter ac:name="old">false</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("attachments list");
  });

  it("detects dynamic content display macros", () => {
    const html = `
      <ac:structured-macro ac:name="contentbylabel">
        <ac:parameter ac:name="label">important</ac:parameter>
      </ac:structured-macro>
    `;
    const unsupported = detectUnsupportedFeatures(html);
    expect(unsupported).toContain("dynamic content display");
  });

  it("returns empty array for documents with only supported features", () => {
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

  it("detects multiple unsupported features in one document", () => {
    const html = `
      <ac:structured-macro ac:name="section">
        <ac:rich-text-body>
          <ac:structured-macro ac:name="column">
            <ac:rich-text-body>
              <ac:structured-macro ac:name="jira">
                <ac:parameter ac:name="key">TEST-1</ac:parameter>
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
    expect(unsupported).toContain("multi-column layout");
    expect(unsupported).toContain("Jira issue integration");
    expect(unsupported).toContain("merged table cells");
  });
});

