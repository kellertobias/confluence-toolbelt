import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectLocalChanges,
  writeLocalBaseSidecar,
} from "../sync/local-changes.js";
import { localBaseSidecarPath } from "../sync/sidecar.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-local-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, "page.md");

describe("detectLocalChanges", () => {
  it("reports a file that does not exist yet", async () => {
    expect(await detectLocalChanges(dir, file())).toBe("missing");
  });

  it("reports clean when the file matches the recorded baseline", async () => {
    fs.writeFileSync(file(), "# Hello\n", "utf8");
    writeLocalBaseSidecar(file(), "# Hello\n");

    expect(await detectLocalChanges(dir, file())).toBe("clean");
  });

  it("ignores trailing-whitespace and line-ending noise", async () => {
    fs.writeFileSync(file(), "# Hello\r\n\r\n", "utf8");
    writeLocalBaseSidecar(file(), "# Hello\n");

    expect(await detectLocalChanges(dir, file())).toBe("clean");
  });

  it("reports dirty when the file was edited since the baseline", async () => {
    writeLocalBaseSidecar(file(), "# Hello\n");
    fs.writeFileSync(file(), "# Hello\n\nmy own notes\n", "utf8");

    expect(await detectLocalChanges(dir, file())).toBe("dirty");
  });

  it("reports unknown for a file with no baseline and no git history", async () => {
    fs.writeFileSync(file(), "hand written\n", "utf8");

    expect(await detectLocalChanges(dir, file())).toBe("unknown");
  });

  it("stores the baseline in a hidden sidecar next to the file", () => {
    writeLocalBaseSidecar(file(), "# Hello\n");

    expect(localBaseSidecarPath(file())).toBe(path.join(dir, ".page.md.base.md"));
    expect(fs.existsSync(path.join(dir, ".page.md.base.md"))).toBe(true);
  });
});
