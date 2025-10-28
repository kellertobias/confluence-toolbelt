/**
 * Jira Task command: prompt for title/content and create a Jira issue.
 *
 * Why: Provide a quick workflow to create tasks without leaving the terminal.
 * How: Reads Jira config from environment (.env), prompts via enquirer, calls
 * Jira Cloud REST API v3 to create the issue, then optionally assigns to self.
 */

import { prompt } from "enquirer";
import readline from "readline";
import { execFile, spawn } from "node:child_process";
import os from "node:os";

interface Options { cwd: string }

/**
 * Build the authorization headers for Jira Cloud using either Basic auth
 * (email + API token) or a bearer access token.
 */
function buildAuthHeaders(): Record<string, string> {
  const accessToken = process.env.JIRA_ACCESS_TOKEN;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (accessToken) {
    return { Authorization: `Bearer ${accessToken}` };
  }
  if (email && apiToken) {
    const basic = Buffer.from(`${email}:${apiToken}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  throw new Error(
    "Jira auth not configured. Set JIRA_ACCESS_TOKEN or JIRA_EMAIL and JIRA_API_TOKEN"
  );
}

/**
 * Execute a short AppleScript one-liner with `osascript` and return stdout.
 *
 * Why: Provide lightweight macOS GUI without extra dependencies.
 * How: Calls the system `osascript` binary; resolves trimmed stdout.
 */
async function runAppleScript(script: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile("osascript", ["-e", script], { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(String(stdout || "").trim());
    });
  });
}

/**
 * Show a macOS dialog asking for text input and return the entered value.
 *
 * Why: Collect a single-line input (title or short text) via GUI.
 * Note: `display dialog` uses a single-line text field; for multi-line content
 * we accept literal "\\n" sequences which will be expanded to real newlines.
 */
async function macPromptText(message: string, defaultAnswer = "", title = "Jira Task"): Promise<string> {
  const osa = `text returned of (display dialog ${JSON.stringify(message)} default answer ${JSON.stringify(defaultAnswer)} with title ${JSON.stringify(title)})`;
  const out = await runAppleScript(osa);
  return out;
}

/**
 * Show a macOS Yes/No dialog and return true for Yes.
 *
 * Why: Capture boolean choices (e.g. assign to yourself) via GUI.
 */
async function macConfirm(message: string, defaultYes = true, title = "Jira Task"): Promise<boolean> {
  const buttons = ["No", "Yes"];
  const defaultButton = defaultYes ? "Yes" : "No";
  const osa = `button returned of (display dialog ${JSON.stringify(message)} buttons {${buttons.map((b) => JSON.stringify(b)).join(",")}} default button ${JSON.stringify(defaultButton)} with title ${JSON.stringify(title)})`;
  const out = await runAppleScript(osa);
  return out === "Yes";
}

/**
 * Copy text to macOS clipboard using `pbcopy`.
 */
async function macCopyToClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", reject);
    p.on("close", () => resolve());
    p.stdin.write(text);
    p.stdin.end();
  });
}

/**
 * Show a macOS user notification via AppleScript.
 */
async function macNotify(title: string, message: string): Promise<void> {
  const osa = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  try {
    await runAppleScript(osa);
  } catch {
    // Best-effort; ignore notification failures.
  }
}

/**
 * Open a temporary document in TextEdit to collect multi-line input and return its contents.
 *
 * Why: AppleScript's `display dialog` text field is single-line; TextEdit provides a familiar multi-line editor.
 * How: Creates a new document in TextEdit, shows an OK/Cancel dialog; on OK reads document text, closes without saving.
 */
async function macPromptMultiline(title = "Jira Task", message = "Enter task content, then click OK."): Promise<string> {
  const osa = `
set docText to ""
tell application "TextEdit"
  activate
  set newDoc to make new document with properties {text:""}
end tell
display dialog ${JSON.stringify(message)} buttons {"Cancel", "OK"} default button "OK" with title ${JSON.stringify(title)}
tell application "TextEdit"
  set docText to (text of newDoc) as text
  close newDoc saving no
end tell
return docText
`;
  return await runAppleScript(osa);
}

/**
 * Convert plain markdown-like text to a minimal Atlassian Document Format (ADF)
 * paragraph document which Jira accepts for the issue description.
 */
function toAdfDescription(text: string): any {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: text
          ? [
              {
                type: "text",
                text,
              },
            ]
          : [],
      },
    ],
  };
}

/**
 * Deep-merge two plain objects. Arrays are replaced by the overlay value.
 */
function deepMerge(base: any, overlay: any): any {
  if (base == null || typeof base !== "object" || Array.isArray(base)) return overlay;
  if (overlay == null || typeof overlay !== "object" || Array.isArray(overlay)) return overlay ?? base;
  const out: any = { ...base };
  for (const key of Object.keys(overlay)) {
    const b = (base as any)[key];
    const o = (overlay as any)[key];
    if (Array.isArray(o)) {
      out[key] = o;
    } else if (o && typeof o === "object") {
      out[key] = deepMerge(b ?? {}, o);
    } else {
      out[key] = o;
    }
  }
  return out;
}

/**
 * Create an issue in Jira Cloud.
 */
async function createJiraIssue(baseUrl: string, payload: any, headers: Record<string, string>): Promise<{ key: string; id: string }> {
  const url = new URL("/rest/api/3/issue", baseUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira create issue failed: ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

/**
 * Retrieve current user's accountId (needed to assign issues to self).
 */
async function getMyself(baseUrl: string, headers: Record<string, string>): Promise<{ accountId: string }> {
  const url = new URL("/rest/api/3/myself", baseUrl).toString();
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira myself failed: ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

/**
 * Assign an issue to an accountId.
 */
async function assignIssue(baseUrl: string, issueKey: string, accountId: string, headers: Record<string, string>): Promise<void> {
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, baseUrl).toString();
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira assign failed: ${res.status} ${res.statusText}\n${text}`);
  }
}

/**
 * Read multiline input from stdin until EOF (Ctrl+D). Returns the captured text.
 */
async function readMultiline(promptLabel: string): Promise<string> {
  process.stdout.write(promptLabel);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let buf = "";
  return await new Promise<string>((resolve) => {
    rl.on("line", (line) => {
      buf += (buf.length ? "\n" : "") + line;
    });
    rl.on("close", () => resolve(buf));
  });
}

/**
 * Entry point for the task command.
 *
 * Prompts:
 *  - Title (single line)
 *  - Content (multiline, confirm with Ctrl+Enter)
 *  - Assign to yourself (default: Yes)
 *
 * Env:
 *  - JIRA_BASE_URL (required)
 *  - JIRA_PROJECT_KEY (required)
 *  - JIRA_EMAIL + JIRA_API_TOKEN or JIRA_ACCESS_TOKEN (required)
 *  - JIRA_ISSUE_TYPE (optional, default "Task")
 *  - JIRA_PRIORITY (optional, maps to priority.name)
 *  - JIRA_LABELS (optional, comma-separated)
 *  - JIRA_COMPONENTS (optional, comma-separated component names)
 */
export async function createTask(opts: Options): Promise<void> {
  const baseUrl = process.env.JIRA_BASE_URL || "";
  const projectKey = process.env.JIRA_PROJECT_KEY || "";
  if (!baseUrl) throw new Error("JIRA_BASE_URL must be set in .env");
  if (!projectKey) throw new Error("JIRA_PROJECT_KEY must be set in .env");

  const issueType = process.env.JIRA_ISSUE_TYPE || "Task";
  const defaultAssign = true; // default Yes

  const guiEnabled = Boolean(process.env.JIRA_GUI);
  const isMac = os.platform() === "darwin";

  /**
   * Gather task inputs either via GUI (macOS + JIRA_GUI) or terminal prompts.
   */
  let basicAnswers: { title: string; assignSelf: boolean };
  let content: string;

  if (guiEnabled && isMac) {
    // GUI mode: collect via macOS dialogs/TextEdit
    const title = await macPromptText("Task title:");
    const assignSelf = await macConfirm("Assign to yourself?", defaultAssign);
    try {
      content = await macPromptMultiline();
    } catch {
      // Fallback: minimal single-line prompt with \n escape if TextEdit is unavailable
      const raw = await macPromptText("Task content (use \\n for newlines):");
      content = raw.replace(/\\n/g, "\n");
    }
    basicAnswers = { title, assignSelf };
  } else {
    // Terminal mode: enquirer + multiline read
    basicAnswers = await prompt([
      { name: "title", type: "input", message: "Task title:" },
      { name: "assignSelf", type: "confirm", initial: defaultAssign, message: "Assign to yourself?" },
    ]) as any;
    // Read content in true multiline mode: Enter inserts newlines, Ctrl+D submits
    content = await readMultiline("Task content (Enter for newline, Ctrl+D to submit):\n");
  }

  const headers = buildAuthHeaders();

  const labels = (process.env.JIRA_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const components = (process.env.JIRA_COMPONENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name }));

  const description = toAdfDescription(content);

  // Parse optional defaults from env: accept either { fields: {...} } or direct fields
  let defaultFields: any = {};
  if (process.env.JIRA_DEFAULT_FIELDS) {
    try {
      const parsed = JSON.parse(process.env.JIRA_DEFAULT_FIELDS);
      defaultFields = parsed?.fields && typeof parsed.fields === "object" ? parsed.fields : parsed;
    } catch (e) {
      console.warn("[task] Ignoring invalid JIRA_DEFAULT_FIELDS JSON:", e);
    }
  }

  // Start with env-derived conveniences only when not explicitly provided in defaults
  let mergedFields: any = { ...defaultFields };
  if (process.env.JIRA_PRIORITY && !mergedFields.priority) mergedFields.priority = { name: process.env.JIRA_PRIORITY };
  if (labels.length && !mergedFields.labels) mergedFields.labels = labels;
  if (components.length && !mergedFields.components) mergedFields.components = components;
  if (!mergedFields.issuetype) mergedFields.issuetype = { name: issueType };

  // Overlay required fields and user-provided values last
  mergedFields = deepMerge(mergedFields, {
    project: { key: projectKey },
    summary: basicAnswers.title,
    description,
  });

  const payload: any = { fields: mergedFields };

  const { key, id } = await createJiraIssue(baseUrl, payload, headers);
  console.log(`[task] Created ${key}`);

  if (basicAnswers.assignSelf) {
    const me = await getMyself(baseUrl, headers);
    await assignIssue(baseUrl, key, me.accountId, headers);
    console.log(`[task] Assigned ${key} to yourself`);
  }

  const issueUrl = new URL(`/browse/${encodeURIComponent(key)}`, baseUrl).toString();
  console.log(`[task] ${issueUrl}`);

  // If GUI mode was used on macOS, copy link and show a notification
  if (guiEnabled && isMac) {
    try {
      await macCopyToClipboard(issueUrl);
    } catch {
      // Ignore clipboard errors; still try to notify
    }
    await macNotify("Jira Task Created", `${key} created and link copied to clipboard`);
  }
}


