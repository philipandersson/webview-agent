import { test, expect, beforeEach, afterEach } from "bun:test";
import { exaSearchTool, firecrawlScrapeTool } from "../src/tools/web";

// Tests hit a mocked globalThis.fetch so we never touch the real Exa /
// Firecrawl APIs. Each test captures the request that would have been sent
// and returns a stubbed response body.

type FetchInput = { url: string; init: RequestInit | undefined };

let lastCall: FetchInput | null = null;
const realFetch = globalThis.fetch;
const realExaKey = process.env.EXA_API_KEY;
const realFireKey = process.env.FIRECRAWL_API_KEY;

function installFetch(responder: (input: FetchInput) => { status?: number; body: unknown }): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastCall = { url: String(url), init };
    const { status = 200, body } = responder(lastCall);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  lastCall = null;
  process.env.EXA_API_KEY = "exa-test-key";
  process.env.FIRECRAWL_API_KEY = "fire-test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realExaKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = realExaKey;
  if (realFireKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = realFireKey;
});

// ─── exa_search ─────────────────────────────────────────────────────────

test("exa_search sends query, numResults, type; auth via x-api-key", async () => {
  installFetch(() => ({
    body: {
      results: [
        { title: "R1", url: "https://r1.example/", score: 0.9, publishedDate: "2026-01-01" },
        { title: "R2", url: "https://r2.example/", score: 0.7 },
      ],
    },
  }));

  const out = await exaSearchTool({ query: "bun webview", numResults: 5 });

  expect(lastCall?.url).toBe("https://api.exa.ai/search");
  expect(lastCall?.init?.method).toBe("POST");
  const headers = lastCall?.init?.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("exa-test-key");
  const sent = JSON.parse(String(lastCall?.init?.body));
  expect(sent).toMatchObject({ query: "bun webview", numResults: 5, type: "auto" });
  expect(sent.contents).toBeUndefined(); // includeText omitted → no contents field

  expect(out.numResults).toBe(2);
  expect(out.results[0]).toMatchObject({ title: "R1", url: "https://r1.example/" });
});

test("exa_search clamps numResults to 1..20", async () => {
  installFetch(() => ({ body: { results: [] } }));

  await exaSearchTool({ query: "a", numResults: 999 });
  expect(JSON.parse(String(lastCall?.init?.body)).numResults).toBe(20);

  await exaSearchTool({ query: "a", numResults: -4 });
  expect(JSON.parse(String(lastCall?.init?.body)).numResults).toBe(1);
});

test("exa_search respects includeText + domain filters", async () => {
  installFetch(() => ({
    body: {
      results: [{ title: "X", url: "https://x.example/", text: "body".repeat(5000), highlights: ["a", "b", "c", "d"] }],
    },
  }));

  const out = await exaSearchTool({
    query: "x",
    includeText: true,
    includeDomains: ["example.com"],
    excludeDomains: ["spam.com"],
  });

  const sent = JSON.parse(String(lastCall?.init?.body));
  expect(sent.contents).toMatchObject({ text: { maxCharacters: 2000 } });
  expect(sent.includeDomains).toEqual(["example.com"]);
  expect(sent.excludeDomains).toEqual(["spam.com"]);

  // Result text is hard-capped at 2000 chars; highlights capped at 3.
  expect(out.results[0]?.text?.length).toBe(2000);
  expect(out.results[0]?.highlights?.length).toBe(3);
});

test("exa_search throws on missing API key", async () => {
  delete process.env.EXA_API_KEY;
  await expect(exaSearchTool({ query: "x" })).rejects.toThrow(/EXA_API_KEY/);
});

test("exa_search surfaces non-200 HTTP errors", async () => {
  installFetch(() => ({ status: 500, body: "boom" }));
  await expect(exaSearchTool({ query: "x" })).rejects.toThrow(/HTTP 500/);
});

test("exa_search requires query", async () => {
  await expect(exaSearchTool({} as unknown as { query: string })).rejects.toThrow(/query/);
});

// ─── firecrawl_scrape ───────────────────────────────────────────────────

test("firecrawl_scrape sends url + onlyMainContent; auth via Bearer", async () => {
  installFetch(() => ({
    body: {
      success: true,
      data: {
        markdown: "# Hello\n\nBody",
        metadata: { title: "Hello", description: "d", statusCode: 200 },
      },
    },
  }));

  const out = await firecrawlScrapeTool({ url: "https://example.com/post" });

  expect(lastCall?.url).toBe("https://api.firecrawl.dev/v1/scrape");
  expect(lastCall?.init?.method).toBe("POST");
  const headers = lastCall?.init?.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer fire-test-key");
  const sent = JSON.parse(String(lastCall?.init?.body));
  expect(sent).toMatchObject({
    url: "https://example.com/post",
    formats: ["markdown"],
    onlyMainContent: true,
  });

  expect(out).toMatchObject({
    url: "https://example.com/post",
    title: "Hello",
    statusCode: 200,
    markdown: "# Hello\n\nBody",
    truncated: false,
  });
});

test("firecrawl_scrape truncates markdown over 20000 chars and flags it", async () => {
  const huge = "x".repeat(50000);
  installFetch(() => ({ body: { success: true, data: { markdown: huge, metadata: {} } } }));

  const out = await firecrawlScrapeTool({ url: "https://example.com/" });
  expect(out.markdown.length).toBe(20000);
  expect(out.truncated).toBe(true);
});

test("firecrawl_scrape opt-in links", async () => {
  installFetch(() => ({
    body: {
      success: true,
      data: {
        markdown: "m",
        metadata: {},
        links: Array.from({ length: 250 }, (_, i) => `https://l${i}.example/`),
      },
    },
  }));

  const out = await firecrawlScrapeTool({ url: "https://x/", includeLinks: true });
  const sent = JSON.parse(String(lastCall?.init?.body));
  expect(sent.formats).toEqual(["markdown", "links"]);
  expect(out.links?.length).toBe(100); // capped at 100
});

test("firecrawl_scrape throws when success=false", async () => {
  installFetch(() => ({ body: { success: false, error: "rate limited" } }));
  await expect(firecrawlScrapeTool({ url: "https://x/" })).rejects.toThrow(/rate limited/);
});

test("firecrawl_scrape throws on missing API key", async () => {
  delete process.env.FIRECRAWL_API_KEY;
  await expect(firecrawlScrapeTool({ url: "https://x/" })).rejects.toThrow(/FIRECRAWL_API_KEY/);
});

test("firecrawl_scrape requires url", async () => {
  await expect(firecrawlScrapeTool({} as unknown as { url: string })).rejects.toThrow(/url/);
});
