// Renders a tool-dispatch result to the terminal. Keeps the per-tool
// summarization logic out of agent.ts so the Agent file only holds
// loop + stream code.

import * as render from "./render";
import type { DispatchResult } from "./tools";
import { isObject } from "./util";

export async function renderToolResult(
  name: string,
  result: DispatchResult,
): Promise<void> {
  const fm = result.forModel;

  if (isErrorResult(fm)) {
    render.toolError(String(fm.error));
    return;
  }

  if (result.markdown) {
    render.toolResult(`${name} rendered markdown`);
    render.renderMarkdownAnsi(result.markdown.ansi);
    return;
  }

  if (result.image) {
    const bytes = isObject(fm) && typeof fm.bytes === "number" ? fm.bytes : "";
    render.toolResult(`${name} · image ${bytes} bytes`);
    await render.renderKittyImageFromB64(result.image.base64, result.image.mime);
    return;
  }

  render.toolResult(`${name} · ${summarize(name, fm)}`);
}

function isErrorResult(v: unknown): v is { error: unknown } {
  return isObject(v) && "error" in v;
}

function summarize(name: string, fm: unknown): string {
  if (!isObject(fm)) return String(fm);
  switch (name) {
    case "write":
      return `${fm.bytes} bytes → ${fm.path}`;
    case "edit":
      return `${fm.replacements} replacement(s) in ${fm.path}`;
    case "read":
      return fm.kind === "text" ? `${fm.lines} lines` : JSON.stringify(fm);
    case "ls": {
      const entries = Array.isArray(fm.entries) ? fm.entries.length : 0;
      return `${entries} entries`;
    }
    case "grep": {
      const matches = Array.isArray(fm.matches) ? fm.matches.length : 0;
      return `${matches} matches`;
    }
    case "find": {
      const files = Array.isArray(fm.files) ? fm.files.length : 0;
      return `${files} files`;
    }
    case "bash": {
      const exit = fm.exitCode;
      const to = fm.timedOut ? " timed-out" : "";
      const stdoutLen = typeof fm.stdout === "string" ? fm.stdout.length : 0;
      const stderrLen = typeof fm.stderr === "string" ? fm.stderr.length : 0;
      return `exit=${exit}${to} · ${stdoutLen + stderrLen} bytes output`;
    }
    case "exa_search": {
      const n = Array.isArray(fm.results) ? fm.results.length : 0;
      return `${n} results`;
    }
    case "firecrawl_scrape": {
      const len = typeof fm.markdown === "string" ? fm.markdown.length : 0;
      const trunc = fm.truncated ? " (truncated)" : "";
      return `${len} md chars${trunc}`;
    }
    default:
      return JSON.stringify(fm).slice(0, 120);
  }
}
