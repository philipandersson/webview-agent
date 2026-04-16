// JSON-schema descriptors + titles/descriptions for every tool the agent can
// call. Kept separate from the dispatcher so schema churn doesn't clutter the
// dispatch switch, and vice versa.

export type ToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const toolDescriptors: ToolDescriptor[] = [
  {
    name: "read",
    description:
      "Read a file from the workspace. Text returned with line numbers (offset/limit supported). PNG/JPG/WEBP/GIF images are returned to you as visual input AND displayed to the user. Markdown (.md) files are rendered beautifully in the terminal and the source is returned to you.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside workspace." },
        offset: { type: "integer", description: "Zero-based starting line (text files)." },
        limit: { type: "integer", description: "Max lines to return (text files)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write",
    description: "Create or overwrite a file. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description:
      "Surgical find-and-replace in a file. `old_string` must match EXACTLY (including whitespace) and must be UNIQUE in the file. To replace multiple occurrences, set `replace_all: true`. To disambiguate, include more surrounding context in `old_string`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command. Always runs with the workspace as cwd. Use this to run Bun scripts (`bun scripts/foo.ts`), invoke binaries, or inspect the environment. Returns { stdout, stderr, exitCode, timedOut }.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", description: "Default 120000 (2 min)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: "Search file contents via ripgrep. Respects .gitignore. Output modes: content | files_with_matches | count.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string", description: "Filter files by glob (e.g., '*.ts')." },
        output_mode: { enum: ["content", "files_with_matches", "count"], type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "find",
    description: "Find files by glob pattern via ripgrep. Respects .gitignore.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '*.ts' or '**/*.md'." },
        path: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "ls",
    description: "List contents of a workspace directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "exa_search",
    description:
      "Fast web search via Exa. PREFER over spinning up a WebView when you just need to find URLs or quick facts — faster, cheaper, no browser cost. Returns ranked results with title/url/score and optionally inline text snippets. Good for the first stage of a fan-out (discovery). Use WebView as fallback when you need interactivity, login, or JS-rendered content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        numResults: { type: "integer", description: "1–20, default 10." },
        includeText: { type: "boolean", description: "Include page text snippets (up to 2000 chars each). Default false." },
        type: { enum: ["auto", "keyword", "neural"], type: "string", description: "Search strategy. Default 'auto'." },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "firecrawl_scrape",
    description:
      "Fetch a URL and return clean extracted markdown via Firecrawl. PREFER over WebView when you only need the content of a known URL (no interaction required) — Firecrawl handles bot-blocking, renders JS, and returns cleanly formatted markdown in one call. Returns { title, markdown, truncated, ... }. Markdown is capped at 20000 chars. Use WebView fallback when you need clicks, scrolls, screenshots, or per-element extraction.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        onlyMainContent: { type: "boolean", description: "Strip nav/footer/sidebars. Default true." },
        includeLinks: { type: "boolean", description: "Also return the list of outgoing links on the page (capped at 100). Default false." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export const toolSchemas = toolDescriptors.map((t) => ({
  type: "function" as const,
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  strict: false,
}));
