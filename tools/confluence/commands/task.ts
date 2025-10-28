/**
 * Jira Task command: prompt for title/content and create a Jira issue.
 *
 * Why: Provide a quick workflow to create tasks without leaving the terminal.
 * How: Reads Jira config from environment (.env), prompts via enquirer, calls
 * Jira Cloud REST API v3 to create the issue, then optionally assigns to self.
 */

import { prompt } from "enquirer";
import readline from "readline";

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

  const basicAnswers: any = await prompt([
    { name: "title", type: "input", message: "Task title:" },
    { name: "assignSelf", type: "confirm", initial: defaultAssign, message: "Assign to yourself?" },
  ]);

  // Read content in true multiline mode: Enter inserts newlines, Ctrl+D submits
  const content = await readMultiline("Task content (Enter for newline, Ctrl+D to submit):\n");

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
}


