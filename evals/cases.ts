import { isObject } from "../src/util";

// Eval cases. Each case is a user prompt plus a set of assertions. Assertions
// score the agent's behavior along three axes:
//   - STRUCTURAL: did the agent produce the right *kind* of solution?
//     (multi-view, parallel helpers, targeted the right sites, etc.)
//   - OUTCOME: does the final text contain the results the user asked for?
//     (valid JSON, minimum record count, required fields)
//
// Structural assertions are cheap and deterministic. Outcome assertions are
// noisy because the target sites are live and may gate bots; we report but
// don't fail the whole suite on a single outcome miss.

export type Assertion = { name: string; pass: boolean; detail?: string };

export type ToolCallSummary = { name: string; count: number };

export type EvalCase = {
  id: string;
  prompt: string;
  /** Assertions on the scripts the agent wrote to workspace/scripts/. */
  structural: (scripts: { path: string; content: string }[], tools: ToolCallSummary[]) => Assertion[];
  /** Assertions on the agent's final assistant message. */
  outcome: (finalText: string) => Assertion[];
};

function any(scripts: { content: string }[], re: RegExp): boolean {
  return scripts.some((s) => re.test(s.content));
}

function countDistinctSites(scripts: { content: string }[], sites: string[]): number {
  const joined = scripts.map((s) => s.content).join("\n");
  return sites.filter((s) => joined.includes(s)).length;
}

function tryParseJson(raw: string | undefined, into: unknown[]): void {
  if (!raw) return;
  try {
    into.push(JSON.parse(raw));
  } catch {
    /* ignore malformed JSON inside a candidate block */
  }
}

function extractJsonBlocks(text: string): unknown[] {
  // Grab any ```json fenced block. If none, try greedy `{...}` / `[...]` at top level.
  const out: unknown[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]+?)```/g)) {
    tryParseJson(m[1], out);
  }
  if (out.length === 0) {
    const greedy = text.match(/(\{[\s\S]+\}|\[[\s\S]+\])/);
    tryParseJson(greedy?.[1], out);
  }
  return out;
}

function flatten(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.flatMap(flatten);
  if (isObject(v)) {
    for (const val of Object.values(v)) {
      if (Array.isArray(val)) return val;
    }
    return [v];
  }
  return [v];
}

export const cases: EvalCase[] = [
  {
    id: "car-search",
    prompt: `Find Porsche 911 GT3 listings currently for sale on at least three of: elferspot.com, autoscout24.com, mobile.de, collectingcars.com, classic.com. Return a JSON array of at least 5 listings, each with { title, price, year, mileage, url, source } (empty string for missing fields is OK, but the source and url must be real).`,
    structural: (scripts, tools) => {
      const siteList = [
        "elferspot.com",
        "autoscout24",
        "mobile.de",
        "collectingcars",
        "classic.com",
      ];
      const sitesHit = countDistinctSites(scripts, siteList);
      const usedExa = tools.some((t) => t.name === "exa_search");
      const usedFirecrawl = tools.some((t) => t.name === "firecrawl_scrape");
      return [
        {
          name: "wrote ≥1 script OR used exa/firecrawl",
          pass: scripts.length >= 1 || usedExa || usedFirecrawl,
          detail: `${scripts.length} scripts · exa:${usedExa} firecrawl:${usedFirecrawl}`,
        },
        {
          name: "used WebView OR firecrawl for extraction",
          pass: any(scripts, /new Bun\.WebView/) || usedFirecrawl,
        },
        {
          name: "targets ≥3 distinct sites",
          pass: sitesHit >= 3,
          detail: `${sitesHit} sites`,
        },
        {
          name: "uses parallelism (Promise.all / parallelMap / parallelWithViews)",
          pass: any(scripts, /Promise\.all|parallelMap|parallelWithViews/),
        },
        {
          name: "wraps navigate with timeout",
          pass: any(scripts, /Promise\.race|navigate\(.+,\s*\d+\)|timeout\(/) || !any(scripts, /new Bun\.WebView/),
        },
      ];
    },
    outcome: (finalText) => {
      const blocks = extractJsonBlocks(finalText);
      const items = blocks.flatMap(flatten).filter((x): x is Record<string, unknown> =>
        !!x && typeof x === "object",
      );
      const withUrl = items.filter((x) => typeof x.url === "string" && x.url.startsWith("http"));
      return [
        {
          name: "final message contains JSON",
          pass: blocks.length > 0,
          detail: `${blocks.length} json blocks`,
        },
        {
          name: "≥5 listing objects",
          pass: items.length >= 5,
          detail: `${items.length} items`,
        },
        {
          name: "≥5 listings have a real http(s) url",
          pass: withUrl.length >= 5,
          detail: `${withUrl.length} with url`,
        },
      ];
    },
  },
  {
    id: "lead-gen-icp",
    prompt: `Given ICP "YC-backed companies, AI/ML B2B SaaS, from W23 or S23 batch", source 10 candidate companies. Use ycombinator.com/companies (filter by batch/industry) and each company's own website. Return JSON array of 10 companies with { name, batch, website, shortDescription, hqCity }.`,
    structural: (scripts, tools) => {
      const usedExa = tools.some((t) => t.name === "exa_search");
      const usedFirecrawl = tools.some((t) => t.name === "firecrawl_scrape");
      return [
        {
          name: "wrote ≥1 script OR used exa/firecrawl",
          pass: scripts.length >= 1 || usedExa || usedFirecrawl,
          detail: `${scripts.length} scripts · exa:${usedExa} firecrawl:${usedFirecrawl}`,
        },
        {
          name: "uses WebView OR firecrawl",
          pass: any(scripts, /new Bun\.WebView/) || usedFirecrawl,
        },
        {
          name: "targets ycombinator.com",
          pass: any(scripts, /ycombinator\.com/) || tools.some((t) => t.name === "exa_search" || t.name === "firecrawl_scrape"),
        },
        {
          name: "uses parallelism or tool-level fan-out",
          pass:
            any(scripts, /Promise\.all|parallelMap|parallelWithViews/) ||
            (tools.find((t) => t.name === "firecrawl_scrape")?.count ?? 0) >= 3 ||
            (tools.find((t) => t.name === "exa_search")?.count ?? 0) >= 2,
        },
        {
          name: "two-stage pattern (list → per-company drilldown)",
          pass:
            (any(scripts, /ycombinator\.com\/companies/) &&
              any(scripts, /href|website|homepageUrl|\.com/)) ||
            (usedExa && usedFirecrawl),
        },
      ];
    },
    outcome: (finalText) => {
      const blocks = extractJsonBlocks(finalText);
      const items = blocks.flatMap(flatten).filter((x): x is Record<string, unknown> =>
        !!x && typeof x === "object",
      );
      return [
        {
          name: "final message contains JSON",
          pass: blocks.length > 0,
          detail: `${blocks.length} json blocks`,
        },
        {
          name: "≥10 company objects",
          pass: items.length >= 10,
          detail: `${items.length} items`,
        },
        {
          name: "≥8 have a website url",
          pass:
            items.filter(
              (x) => typeof x.website === "string" && x.website.includes("."),
            ).length >= 8,
        },
      ];
    },
  },
  {
    id: "candidate-sourcing",
    prompt: `Given target profile "Senior ML engineer with transformer / LLM work, 5+ years, active on GitHub", source 5 candidate GitHub profiles. Use GitHub search (github.com/search?q=...&type=users) plus each user's profile page (github.com/<login>). Return JSON array of 5 candidates with { login, name, bio, profileUrl, notableRepo }.`,
    structural: (scripts, tools) => {
      const usedExa = tools.some((t) => t.name === "exa_search");
      const usedFirecrawl = tools.some((t) => t.name === "firecrawl_scrape");
      return [
        {
          name: "wrote ≥1 script OR used exa/firecrawl",
          pass: scripts.length >= 1 || usedExa || usedFirecrawl,
          detail: `${scripts.length} scripts · exa:${usedExa} firecrawl:${usedFirecrawl}`,
        },
        {
          name: "uses WebView OR firecrawl",
          pass: any(scripts, /new Bun\.WebView/) || usedFirecrawl,
        },
        {
          name: "targets github.com",
          pass: any(scripts, /github\.com/) || usedExa || usedFirecrawl,
        },
        {
          name: "uses parallelism or tool-level fan-out",
          pass:
            any(scripts, /Promise\.all|parallelMap|parallelWithViews/) ||
            (tools.find((t) => t.name === "firecrawl_scrape")?.count ?? 0) >= 3,
        },
        {
          name: "two-stage pattern (search → per-profile drilldown)",
          pass:
            (any(scripts, /github\.com\/search/) &&
              any(scripts, /github\.com\/\$?\{|github\.com\/[A-Za-z0-9-]+/)) ||
            (usedExa && (usedFirecrawl || any(scripts, /github\.com\//))),
        },
      ];
    },
    outcome: (finalText) => {
      const blocks = extractJsonBlocks(finalText);
      const items = blocks.flatMap(flatten).filter((x): x is Record<string, unknown> =>
        !!x && typeof x === "object",
      );
      const withProfile = items.filter(
        (x) =>
          typeof x.profileUrl === "string" && x.profileUrl.includes("github.com/"),
      );
      return [
        {
          name: "final message contains JSON",
          pass: blocks.length > 0,
          detail: `${blocks.length} json blocks`,
        },
        {
          name: "≥5 candidate objects",
          pass: items.length >= 5,
          detail: `${items.length} items`,
        },
        {
          name: "≥5 have github.com profileUrl",
          pass: withProfile.length >= 5,
          detail: `${withProfile.length} with github profile`,
        },
      ];
    },
  },
];
