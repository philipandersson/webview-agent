// Tool registry: schemas live in ./schemas; per-tool implementations live in
// their sibling files (fs, bash, web, …). This module is just the dispatcher
// that turns a tool name + raw JSON args string into a DispatchResult.

import { readTool, writeTool, editTool, lsTool, grepTool, findTool } from "./fs";
import { bashTool } from "./bash";
import { exaSearchTool, firecrawlScrapeTool } from "./web";
import { errorMessage } from "../util";

export { toolDescriptors, toolSchemas, type ToolDescriptor } from "./schemas";

export type DispatchResult = {
  forModel: unknown;
  image?: { mime: string; base64: string };
  markdown?: { ansi: string };
};

export async function dispatch(name: string, rawArgs: string): Promise<DispatchResult> {
  let args: any;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (err) {
    return { forModel: { error: `invalid JSON arguments: ${errorMessage(err)}` } };
  }

  try {
    switch (name) {
      case "read": {
        const r = await readTool(args);
        if (r.kind === "image") {
          return {
            forModel: { kind: "image", mime: r.mime, path: r.path, bytes: r.bytes },
            image: { mime: r.mime, base64: r.base64 },
          };
        }
        if (r.kind === "markdown") {
          return {
            forModel: { kind: "markdown", path: r.path, source: r.source },
            markdown: { ansi: r.ansi },
          };
        }
        return { forModel: r };
      }
      case "write":
        return { forModel: await writeTool(args) };
      case "edit":
        return { forModel: await editTool(args) };
      case "bash":
        return { forModel: await bashTool(args) };
      case "grep":
        return { forModel: await grepTool(args) };
      case "find":
        return { forModel: await findTool(args) };
      case "ls":
        return { forModel: await lsTool(args) };
      case "exa_search":
        return { forModel: await exaSearchTool(args) };
      case "firecrawl_scrape":
        return { forModel: await firecrawlScrapeTool(args) };
      default:
        return { forModel: { error: `unknown tool: ${name}` } };
    }
  } catch (err) {
    return { forModel: { error: errorMessage(err) } };
  }
}
