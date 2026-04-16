import { readTool, writeTool, editTool, lsTool, grepTool, findTool } from "./fs";
import { bashTool } from "./bash";
import { errorMessage } from "../util";

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
];

export const toolSchemas = toolDescriptors.map((t) => ({
  type: "function" as const,
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  strict: false,
}));

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
      default:
        return { forModel: { error: `unknown tool: ${name}` } };
    }
  } catch (err) {
    return { forModel: { error: errorMessage(err) } };
  }
}
