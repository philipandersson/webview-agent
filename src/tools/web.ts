// Web lookup tools:
//   exa_search     — fast web search via Exa (api.exa.ai)
//   firecrawl_scrape — clean URL → markdown via Firecrawl (api.firecrawl.dev)
//
// These are preferred over WebView for simple lookups: faster, cheaper
// (tokens-wise), and no browser spin-up cost. WebView remains the answer
// when you need interactivity (click, type, screenshot) or the page is
// hostile to non-browser fetching.
//
// Both read their API keys from env:
//   EXA_API_KEY
//   FIRECRAWL_API_KEY

type ExaSearchArgs = {
  query: string;
  numResults?: number;
  includeText?: boolean;
  type?: "auto" | "keyword" | "neural";
  includeDomains?: string[];
  excludeDomains?: string[];
};

type ExaResult = {
  title?: string;
  url: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  highlights?: string[];
};

const EXA_ENDPOINT = "https://api.exa.ai/search";
const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";

const MAX_EXA_RESULTS = 20;
const MAX_TEXT_PER_RESULT = 2000;
const MAX_FIRECRAWL_MARKDOWN = 20000;
const DEFAULT_TIMEOUT_MS = 30000;

function requireKey(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in the environment`);
  return v;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    return JSON.parse(body) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function exaSearchTool(args: ExaSearchArgs): Promise<{
  query: string;
  numResults: number;
  results: ExaResult[];
}> {
  if (!args?.query || typeof args.query !== "string") {
    throw new Error("query is required");
  }
  const key = requireKey("EXA_API_KEY");
  const numResults = Math.min(Math.max(args.numResults ?? 10, 1), MAX_EXA_RESULTS);

  const body: Record<string, unknown> = {
    query: args.query,
    numResults,
    type: args.type ?? "auto",
  };
  if (args.includeText) {
    body.contents = { text: { maxCharacters: MAX_TEXT_PER_RESULT }, highlights: true };
  }
  if (args.includeDomains?.length) body.includeDomains = args.includeDomains;
  if (args.excludeDomains?.length) body.excludeDomains = args.excludeDomains;

  const data = await fetchJson<{ results: ExaResult[] }>(EXA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  const results = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    publishedDate: r.publishedDate,
    author: r.author,
    score: r.score,
    ...(r.text ? { text: r.text.slice(0, MAX_TEXT_PER_RESULT) } : {}),
    ...(r.highlights ? { highlights: r.highlights.slice(0, 3) } : {}),
  }));

  return { query: args.query, numResults: results.length, results };
}

type FirecrawlArgs = {
  url: string;
  onlyMainContent?: boolean;
  includeLinks?: boolean;
};

type FirecrawlResponse = {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      language?: string;
      sourceURL?: string;
      statusCode?: number;
      [k: string]: unknown;
    };
    links?: string[];
  };
  error?: string;
};

export async function firecrawlScrapeTool(args: FirecrawlArgs): Promise<{
  url: string;
  title?: string;
  description?: string;
  statusCode?: number;
  markdown: string;
  truncated: boolean;
  links?: string[];
}> {
  if (!args?.url || typeof args.url !== "string") {
    throw new Error("url is required");
  }
  const key = requireKey("FIRECRAWL_API_KEY");

  const formats: (string | { type: string })[] = ["markdown"];
  if (args.includeLinks) formats.push("links");

  const body = {
    url: args.url,
    formats,
    onlyMainContent: args.onlyMainContent ?? true,
  };

  const data = await fetchJson<FirecrawlResponse>(FIRECRAWL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    timeoutMs: 60000,
  });

  if (!data.success) {
    throw new Error(`firecrawl: ${data.error ?? "unknown error"}`);
  }

  const full = data.data?.markdown ?? "";
  const truncated = full.length > MAX_FIRECRAWL_MARKDOWN;
  return {
    url: args.url,
    title: data.data?.metadata?.title,
    description: data.data?.metadata?.description,
    statusCode: data.data?.metadata?.statusCode,
    markdown: full.slice(0, MAX_FIRECRAWL_MARKDOWN),
    truncated,
    ...(args.includeLinks && data.data?.links ? { links: data.data.links.slice(0, 100) } : {}),
  };
}
