import pc from "picocolors";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const CHUNK = 4096;

export function renderKittyImageFromB64(b64: string, mime = "image/png", cols = 40): void {
  if (!process.stdout.isTTY) {
    console.log(pc.dim(`    [image: ${b64.length} b64 bytes, stdout is not a TTY]`));
    return;
  }

  let pngB64 = b64;
  if (mime !== "image/png") {
    const converted = convertToPngBase64(b64, mime);
    if (!converted) {
      console.log(pc.dim(`    [image: could not convert ${mime} to png]`));
      return;
    }
    pngB64 = converted;
  }

  if (pngB64.length <= CHUNK) {
    process.stdout.write(`${ESC}_Ga=T,f=100,c=${cols},m=0;${pngB64}${ST}\n`);
    return;
  }

  for (let i = 0; i < pngB64.length; i += CHUNK) {
    const chunk = pngB64.slice(i, i + CHUNK);
    const isFirst = i === 0;
    const isLast = i + CHUNK >= pngB64.length;
    const m = isLast ? 0 : 1;
    const header = isFirst ? `a=T,f=100,c=${cols},m=${m}` : `m=${m}`;
    process.stdout.write(`${ESC}_G${header};${chunk}${ST}`);
  }
  process.stdout.write("\n");
}

function convertToPngBase64(b64: string, mime: string): string | null {
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = extMap[mime];
  if (!ext) return null;

  const dir = mkdtempSync(path.join(tmpdir(), "bun-agent-img-"));
  const src = path.join(dir, `in.${ext}`);
  const dst = path.join(dir, `out.png`);
  try {
    writeFileSync(src, Buffer.from(b64, "base64"));
    const proc = Bun.spawnSync(["sips", "-s", "format", "png", src, "--out", dst], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    return readFileSync(dst).toString("base64");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function reasoning(delta: string): void {
  process.stdout.write(pc.dim(pc.italic(delta)));
}

export function reasoningStart(): void {
  process.stdout.write(pc.dim("·  "));
}

export function reasoningEnd(): void {
  process.stdout.write("\n");
}

export function banner(): void {
  const line = pc.dim("─".repeat(Math.max(20, Math.min(60, (process.stdout.columns ?? 60) - 4))));
  console.log("");
  console.log(`  ${line}`);
  console.log(`  ${pc.bold("bun web agent")}  ${pc.dim("· gpt-5.4 · bun webview")}`);
  console.log(`  ${line}`);
  console.log("");
}

export function goalPromptString(): string {
  return `${pc.dim("╭─")} ${pc.bold("goal")}\n${pc.dim("╰─›")} `;
}

export function toolCall(name: string, args: unknown): void {
  const preview = summarizeArgs(args);
  console.log(`${pc.cyan("›")} ${pc.cyan(pc.bold(name))}${preview ? pc.dim(`  ${preview}`) : ""}`);
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    let s: string;
    if (typeof v === "string") {
      s = v.length > 60 ? JSON.stringify(v.slice(0, 60)) + "…" : JSON.stringify(v);
    } else {
      s = JSON.stringify(v);
      if (s && s.length > 60) s = s.slice(0, 60) + "…";
    }
    parts.push(`${k}=${s}`);
  }
  const joined = parts.join(" ");
  return joined.length > 140 ? joined.slice(0, 140) + "…" : joined;
}

export function toolResult(summary: string, ok = true): void {
  const mark = ok ? pc.green("✓") : pc.red("✗");
  console.log(`  ${mark} ${pc.dim(summary)}`);
}

export function toolError(message: string): void {
  console.log(`  ${pc.red("✗")} ${pc.red(message)}`);
}

export function info(msg: string): void {
  console.log(pc.dim(msg));
}

export function warn(msg: string): void {
  console.log(pc.yellow(msg));
}

export function errorLine(msg: string): void {
  console.log(pc.red(msg));
}

let assistantBuffer = "";

export function assistantChunk(delta: string): void {
  assistantBuffer += delta;
  while (true) {
    const idx = assistantBuffer.indexOf("\n\n");
    if (idx === -1) break;
    const block = assistantBuffer.slice(0, idx);
    assistantBuffer = assistantBuffer.slice(idx + 2);
    writeAssistantBlock(block);
  }
}

export function assistantFlush(): void {
  if (assistantBuffer.trim().length === 0) {
    assistantBuffer = "";
    return;
  }
  writeAssistantBlock(assistantBuffer);
  assistantBuffer = "";
}

function writeAssistantBlock(md: string): void {
  const cols = Math.max(40, (process.stdout.columns ?? 80) - 4);
  const out = Bun.markdown.ansi(md, {
    colors: true,
    hyperlinks: true,
    kittyGraphics: true,
    columns: cols,
  });
  const indented = out
    .split("\n")
    .map((l) => (l.length ? `  ${l}` : ""))
    .join("\n");
  process.stdout.write(indented);
  if (!out.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write("\n");
}

export function renderMarkdownAnsi(ansi: string): void {
  const indented = ansi
    .split("\n")
    .map((l) => (l.length ? `  ${l}` : ""))
    .join("\n");
  process.stdout.write(indented);
  if (!ansi.endsWith("\n")) process.stdout.write("\n");
}
