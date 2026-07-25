import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const API_ROOT = "https://api.github.com/repos/SigmaHQ/sigma";
const RAW_ROOT = "https://raw.githubusercontent.com/SigmaHQ/sigma/master";

function safePath(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.includes("..")) throw new Error("Path traversal is not allowed");
  return normalized;
}

async function githubJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "sigma-mcp-vercel",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    next: { revalidate: 300 },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

const handler = createMcpHandler(
  async (server) => {
    server.tool(
      "list_sigma_directory",
      "List files and subdirectories in the SigmaHQ rule repository.",
      {
        path: z.string().default("rules").describe("Repository directory, for example rules/windows or rules/linux"),
      },
      async ({ path }) => {
        try {
          const clean = safePath(path);
          const items = await githubJson(`${API_ROOT}/contents/${clean}?ref=master`);
          if (!Array.isArray(items)) throw new Error("The requested path is not a directory");
          const text = items
            .map((item: any) => `${item.type === "dir" ? "directory" : "file"}\t${item.path}`)
            .join("\n");
          return { content: [{ type: "text", text: text || "Directory is empty." }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    );

    server.tool(
      "search_sigma_rules",
      "Search Sigma rule filenames and repository paths. The search is case-insensitive and uses the SigmaHQ repository tree.",
      {
        query: z.string().min(1).describe("Text to find in a rule filename or path, such as powershell or ransomware"),
        ruleSet: z.string().default("rules").describe("Path prefix to search, such as rules, rules-threat-hunting, or rules-emerging-threats"),
        maxResults: z.number().int().min(1).max(100).default(20).describe("Maximum number of matching paths"),
      },
      async ({ query, ruleSet, maxResults }) => {
        try {
          const prefix = safePath(ruleSet).toLowerCase();
          const needle = query.trim().toLowerCase();
          const tree = await githubJson(`${API_ROOT}/git/trees/master?recursive=1`);
          const matches = (Array.isArray(tree.tree) ? tree.tree : [])
            .filter((entry: any) => entry.type === "blob" && entry.path?.toLowerCase().startsWith(prefix + "/"))
            .filter((entry: any) => /\.ya?ml$/i.test(entry.path) && entry.path.toLowerCase().includes(needle))
            .slice(0, maxResults)
            .map((entry: any) => entry.path);
          const note = tree.truncated ? "\n\nNote: GitHub returned a truncated repository tree." : "";
          return { content: [{ type: "text", text: (matches.length ? matches.join("\n") : "No matching rule paths found.") + note }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    );

    server.tool(
      "get_sigma_rule",
      "Retrieve the complete YAML source of a Sigma rule by repository path.",
      {
        path: z.string().min(1).describe("Full rule path returned by search_sigma_rules, ending in .yml or .yaml"),
      },
      async ({ path }) => {
        try {
          const clean = safePath(path);
          if (!/\.ya?ml$/i.test(clean)) throw new Error("Sigma rule path must end in .yml or .yaml");
          const encoded = clean.split("/").map(encodeURIComponent).join("/");
          const response = await fetch(`${RAW_ROOT}/${encoded}`, { next: { revalidate: 300 } });
          if (!response.ok) throw new Error(`Rule fetch failed (${response.status})`);
          const yaml = await response.text();
          return { content: [{ type: "text", text: yaml }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    );
  },
  {
    capabilities: {
      tools: {
        list_sigma_directory: { description: "List files and directories in the SigmaHQ rule repository" },
        search_sigma_rules: { description: "Search Sigma rule filenames and repository paths" },
        get_sigma_rule: { description: "Retrieve a Sigma rule's YAML source by path" },
      },
    },
  },
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 60,
    disableSse: true,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
