// Web lookup tools:
//   fetch_url        — cheap HTTP GET → { status, title, textPreview, jsGated }
//   exa_search       — fast web search via Exa (api.exa.ai)
//   firecrawl_scrape — clean URL → markdown via Firecrawl (api.firecrawl.dev)
//
// `fetch_url` is a pre-flight: a few hundred tokens, one HTTP request, enough
// info to decide between firecrawl and WebView (or whether to bother at all).
// WebView remains the primary browser tool for any extraction or interaction.
//
// Exa/Firecrawl read keys from env (EXA_API_KEY, FIRECRAWL_API_KEY). fetch_url
// needs nothing — direct HTTP.

import { requireEnv } from "../env";

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

type FetchUrlArgs = {
  url: string;
  timeoutMs?: number;
};

export type FetchUrlResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  bytes: number;
  title?: string;
  metaDescription?: string;
  textPreview: string;
  jsGated: boolean;
  jsGatedReason?: string;
};

const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const FETCH_TEXT_PREVIEW_CHARS = 2000;
const FETCH_MAX_BYTES = 500_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtmlToText(html: string): string {
  const noScript = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return decodeEntities(noScript.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const t = decodeEntities(m[1]!).replace(/\s+/g, " ").trim();
  return t || undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const re = /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/i;
  const og = /<meta\b[^>]*\bproperty=["']og:description["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/i;
  const m = html.match(re) || html.match(og);
  if (!m) return undefined;
  const t = decodeEntities(m[1]!).replace(/\s+/g, " ").trim();
  return t || undefined;
}

function detectJsGated(html: string, text: string): { gated: boolean; reason?: string } {
  const lower = html.toLowerCase();
  if (/please enable javascript|you need to enable javascript|enable javascript to run/.test(lower)) {
    return { gated: true, reason: "explicit 'enable JavaScript' message" };
  }
  if (/<noscript[^>]*>\s*<[^>]*>?[^<]{30,}/i.test(html)) {
    return { gated: true, reason: "prominent <noscript> fallback" };
  }
  const scriptBytes = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [])
    .reduce((n, s) => n + s.length, 0);
  const htmlLen = html.length;
  if (htmlLen > 5000 && text.length < 300 && scriptBytes / htmlLen > 0.4) {
    return { gated: true, reason: "large page but <300 chars of visible text — JS-rendered" };
  }
  if (htmlLen > 20000 && text.length < 500) {
    return { gated: true, reason: "20KB+ HTML with <500 chars of visible text" };
  }
  return { gated: false };
}

export async function fetchUrlTool(args: FetchUrlArgs): Promise<FetchUrlResult> {
  if (!args?.url || typeof args.url !== "string") {
    throw new Error("url is required");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 15000);
  try {
    const res = await fetch(args.url, {
      method: "GET",
      headers: {
        "User-Agent": FETCH_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const contentType = res.headers.get("content-type") ?? undefined;
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (total < FETCH_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      try { await reader.cancel(); } catch {}
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(
      chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks),
    );
    const isHtml = !contentType || /html|xml/i.test(contentType);
    const text = isHtml ? stripHtmlToText(body) : body;
    const { gated, reason } = isHtml
      ? detectJsGated(body, text)
      : { gated: false, reason: undefined };
    return {
      url: args.url,
      finalUrl: res.url,
      status: res.status,
      ...(contentType ? { contentType } : {}),
      bytes: total,
      ...(isHtml ? { title: extractTitle(body), metaDescription: extractMetaDescription(body) } : {}),
      textPreview: text.slice(0, FETCH_TEXT_PREVIEW_CHARS),
      jsGated: gated,
      ...(reason ? { jsGatedReason: reason } : {}),
    };
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
  const key = requireEnv("EXA_API_KEY");
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
  const key = requireEnv("FIRECRAWL_API_KEY");

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
