import { safePath, WORKSPACE } from "./paths";
import { renderMarkdown } from "../render";
import { readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type ReadResult =
  | { kind: "text"; text: string; path: string; lines: number }
  | { kind: "image"; mime: string; base64: string; path: string; bytes: number }
  | { kind: "markdown"; source: string; ansi: string; path: string };

export async function readTool(args: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<ReadResult> {
  const abs = safePath(args.path);
  const ext = path.extname(abs).toLowerCase();

  if (ext in IMAGE_EXT) {
    const bytes = await Bun.file(abs).arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    return { kind: "image", mime: IMAGE_EXT[ext]!, base64, path: args.path, bytes: bytes.byteLength };
  }

  const source = await Bun.file(abs).text();

  if (ext === ".md") {
    return { kind: "markdown", source, ansi: renderMarkdown(source), path: args.path };
  }

  const all = source.split("\n");
  const start = Math.max(0, args.offset ?? 0);
  const end = args.limit != null ? start + args.limit : all.length;
  const slice = all.slice(start, end);
  const width = String(start + slice.length).length;
  const numbered = slice
    .map((ln, i) => `${String(start + i + 1).padStart(Math.max(6, width))}\t${ln}`)
    .join("\n");

  return { kind: "text", text: numbered, path: args.path, lines: all.length };
}

export async function writeTool(args: {
  path: string;
  content: string;
}): Promise<{ bytes: number; path: string }> {
  const abs = safePath(args.path);
  await mkdir(path.dirname(abs), { recursive: true });
  const bytes = await Bun.write(abs, args.content);
  return { bytes, path: args.path };
}

export async function editTool(args: {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}): Promise<{ replacements: number; path: string }> {
  if (!args.old_string) {
    throw new Error("old_string must not be empty; use write to create a new file");
  }
  if (args.old_string === args.new_string) {
    throw new Error("old_string and new_string are identical; no change requested");
  }

  const abs = safePath(args.path);
  const src = await Bun.file(abs).text();

  let next: string;
  let replacements: number;

  if (args.replace_all) {
    const parts = src.split(args.old_string);
    if (parts.length === 1) throw new Error(`old_string not found in ${args.path}`);
    next = parts.join(args.new_string);
    replacements = parts.length - 1;
  } else {
    const first = src.indexOf(args.old_string);
    if (first === -1) throw new Error(`old_string not found in ${args.path}`);
    const second = src.indexOf(args.old_string, first + args.old_string.length);
    if (second !== -1) {
      throw new Error(
        `old_string is non-unique in ${args.path} (found multiple matches). Add surrounding context or pass replace_all=true.`,
      );
    }
    next = src.slice(0, first) + args.new_string + src.slice(first + args.old_string.length);
    replacements = 1;
  }

  await Bun.write(abs, next);
  return { replacements, path: args.path };
}

export async function lsTool(args: {
  path?: string;
}): Promise<{ entries: Array<{ name: string; kind: "file" | "dir"; size?: number }>; path: string }> {
  const rel = args.path ?? "";
  const abs = safePath(rel);
  const names = await readdir(abs);
  const entries = await Promise.all(
    names.map(async (name) => {
      const st = await stat(path.join(abs, name));
      return st.isDirectory()
        ? { name, kind: "dir" as const }
        : { name, kind: "file" as const, size: st.size };
    }),
  );
  return { entries, path: rel || "." };
}

function assertSafeGlob(glob: string | undefined): void {
  if (glob == null) return;
  if (glob.includes("..")) {
    throw new Error(`glob must not contain ".." — got ${JSON.stringify(glob)}`);
  }
  if (glob.startsWith("/")) {
    throw new Error(`glob must be relative — got ${JSON.stringify(glob)}`);
  }
}

export async function grepTool(args: {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
}): Promise<{ matches: string[] }> {
  assertSafeGlob(args.glob);
  const abs = args.path ? safePath(args.path) : WORKSPACE;
  const mode = args.output_mode ?? "content";
  const flags: string[] = ["--hidden", "--no-messages"];
  if (mode === "files_with_matches") flags.push("-l");
  else if (mode === "count") flags.push("-c");
  else flags.push("-n");
  if (args.glob) flags.push("-g", args.glob);

  const result = await $`rg ${flags} ${args.pattern} ${abs}`.nothrow().quiet();
  const text = result.stdout.toString();
  const matches = text.split("\n").filter((l) => l.length > 0);
  return { matches };
}

export async function findTool(args: {
  pattern: string;
  path?: string;
}): Promise<{ files: string[] }> {
  assertSafeGlob(args.pattern);
  const abs = args.path ? safePath(args.path) : WORKSPACE;
  const result = await $`rg --files --hidden --no-messages -g ${args.pattern} ${abs}`.nothrow().quiet();
  const files = result.stdout.toString().split("\n").filter((l) => l.length > 0);
  return { files };
}
