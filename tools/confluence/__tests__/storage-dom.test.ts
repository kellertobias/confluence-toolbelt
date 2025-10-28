import { describe, it, expect } from "vitest";
import { storageToMarkdownBlocks } from "../storage-dom.js";

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
});


