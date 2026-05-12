// AuthInfo type inlined to avoid @modelcontextprotocol/sdk dependency
type AuthInfo = {
  token: string;
  scopes: string[];
  clientId: string;
  extra?: Record<string, unknown>;
};
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

// ============================================
// Configuration
// ============================================
export const runtime = "nodejs";
export const maxDuration = 60;

const GITHUB_PAT = process.env.GITHUB_PAT!;
const CLAUDE_MCP_SECRET = process.env.CLAUDE_MCP_SECRET!;
const GITHUB_OWNER = "almathropic";
const GITHUB_REPO = "vitrerie-portail";

// ============================================
// Helpers
// ============================================
function encodePath(p: string): string {
  return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function github(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "claude-mcp-server-almathropic",
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
    isError: true,
  };
}

// ============================================
// MCP handler
// ============================================
const handler = createMcpHandler(
  async (server) => {
    // ----- ping -----
    server.registerTool(
      "ping",
      {
        title: "Ping",
        description: "Test connectivity to the MCP server. Returns pong if alive.",
        inputSchema: z.object({}),
      },
      async () =>
        ok(`pong 🟢 MCP server alive. Target: ${GITHUB_OWNER}/${GITHUB_REPO}`)
    );

    // ----- read_file -----
    server.registerTool(
      "read_file",
      {
        title: "Read file from repo",
        description: `Read a file's content from ${GITHUB_OWNER}/${GITHUB_REPO}. Returns content + SHA (needed for updates).`,
        inputSchema: z.object({
          path: z.string().describe("File path (e.g. 'README.md', 'backend/app/routes/mails.py')"),
          ref: z.string().optional().describe("Branch/tag/SHA (default: 'dev')"),
        }),
      },
      async ({ path, ref }) => {
        try {
          const r = ref || "dev";
          const data = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(r)}`
          );
          if (data.type !== "file") return err(`${path} is not a file (type: ${data.type})`);
          const content = Buffer.from(data.content, "base64").toString("utf-8");
          return ok(`📄 ${path} (ref: ${r}, sha: ${data.sha})\n\n---\n\n${content}`);
        } catch (e: any) {
          return err(e.message);
        }
      }
    );

    // ----- list_files -----
    server.registerTool(
      "list_files",
      {
        title: "List files in a directory",
        description: `List files and folders in a directory of ${GITHUB_OWNER}/${GITHUB_REPO}.`,
        inputSchema: z.object({
          path: z.string().describe("Directory path (use '' for root, or 'backend/app')"),
          ref: z.string().optional().describe("Branch/tag/SHA (default: 'dev')"),
        }),
      },
      async ({ path, ref }) => {
        try {
          const r = ref || "dev";
          const data = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(r)}`
          );
          if (!Array.isArray(data)) return err(`${path} is not a directory`);
          const items = data
            .sort((a: any, b: any) =>
              a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
            )
            .map((item: any) => `${item.type === "dir" ? "📁" : "📄"} ${item.name}`)
            .join("\n");
          return ok(`Contents of '${path || "/"}' (ref: ${r}):\n\n${items}`);
        } catch (e: any) {
          return err(e.message);
        }
      }
    );

    // ----- list_branches -----
    server.registerTool(
      "list_branches",
      {
        title: "List branches",
        description: `List branches in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const data = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/branches?per_page=100`
          );
          const lines = data
            .map(
              (b: any) =>
                `- ${b.name}${b.protected ? " 🔒" : ""}  (sha: ${b.commit.sha.substring(0, 7)})`
            )
            .join("\n");
          return ok(`Branches:\n\n${lines}`);
        } catch (e: any) {
          return err(e.message);
        }
      }
    );

    // ----- list_pull_requests -----
    server.registerTool(
      "list_pull_requests",
      {
        title: "List pull requests",
        description: `List recent PRs in ${GITHUB_OWNER}/${GITHUB_REPO}.`,
        inputSchema: z.object({
          state: z.enum(["open", "closed", "all"]).optional().describe("PR state (default: 'open')"),
        }),
      },
      async ({ state }) => {
        try {
          const s = state || "open";
          const prs = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=${s}&per_page=20`
          );
          if (prs.length === 0) return ok(`No PRs with state '${s}'.`);
          const lines = prs
            .map(
              (pr: any) =>
                `#${pr.number} [${pr.state}] ${pr.title}\n  by ${pr.user.login} • ${pr.head.ref} → ${pr.base.ref}\n  ${pr.html_url}`
            )
            .join("\n\n");
          return ok(`PRs (${s}):\n\n${lines}`);
        } catch (e: any) {
          return err(e.message);
        }
      }
    );

    // ----- create_branch -----
    server.registerTool(
      "create_branch",
      {
        title: "Create a branch",
        description: `Create a new branch forked from a source branch.`,
        inputSchema: z.object({
          new_branch: z.string().describe("Name of the new branch"),
          from_branch: z.string().optional().describe("Source branch (default: 'dev')"),
        }),
      },
      async ({ new_branch, from_branch }) => {
        try {
          const source = from_branch || "dev";
          const ref = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(source)}`
          );
          const created = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ref: `refs/heads/${new_branch}`,
                sha: ref.object.sha,
              }),
            }
          );
          return ok(
            `✅ Branch '${new_branch}' created from '${source}' (sha: ${created.object.sha.substring(0, 7)})`
          );
        } catch (e: any) {
          return err(e.message);
        }
      }
    );

    // ----- create_or_update_file -----
    server.registerTool(
      "create_or_update_file",
      {
        title: "Create or update a file",
        description: `Create a new file or update an existing one. Commits to the branch. For updates, provide the current SHA.`,
        inputSchema: z.object({
          path: z.string().describe("File path"),
          content: z.string().describe("File content (UTF-8)"),
          message: z.string().describe("Commit message"),
          branch: z.string().describe("Target branch"),
          sha: z.string().optional().describe("Current SHA (REQUIRED for updates, omit for new files)"),
        }),
      },
      async ({ path, content, message, branch, sha }) => {
        try {
          const body: Record<string, any> = {
            message,
            content: Buffer.from(content, "utf-8").toString("base64"),
            branch,
          };
          if (sha) body.sha = sha;
          const data = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(path)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          );
          return ok(
            `✅ Committed to ${branch}\nFile: ${path}\nCommit: ${data.commit.sha.substring(0, 7)}\nURL: ${data.commit.html_url}`
          );
        } catch (e: any) {
          return err(e.message);
        }
      }
    );

    // ----- create_pull_request -----
    server.registerTool(
      "create_pull_request",
      {
        title: "Create a pull request",
        description: `Open a pull request.`,
        inputSchema: z.object({
          title: z.string().describe("PR title"),
          body: z.string().describe("PR description (Markdown)"),
          head: z.string().describe("Source branch"),
          base: z.string().describe("Target branch (e.g. 'dev')"),
          draft: z.boolean().optional().describe("Draft PR? (default: false)"),
        }),
      },
      async ({ title, body, head, base, draft }) => {
        try {
          const pr = await github(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, body, head, base, draft: draft ?? false }),
            }
          );
          return ok(`✅ PR #${pr.number} opened: ${pr.title}\n${pr.html_url}`);
        } catch (e: any) {
          return err(e.message);
        }
      }
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 60,
    disableSse: true,
  }
);

// ============================================
// Auth wrapper (Bearer token)
// ============================================
const verifyToken = async (
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  if (bearerToken !== CLAUDE_MCP_SECRET) return undefined;
  return {
    token: bearerToken,
    scopes: ["repo:read", "repo:write"],
    clientId: "claude-ai-franck",
    extra: {},
  };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
