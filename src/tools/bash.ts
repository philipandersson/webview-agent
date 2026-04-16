import { WORKSPACE } from "./paths";

const OUTPUT_CAP = 128_000;

export async function bashTool(args: {
  command: string;
  timeout_ms?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const timeout = args.timeout_ms ?? 120_000;

  const proc = Bun.spawn(["bash", "-c", args.command], {
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, timeout);

  const [stdout, stderr, exitCode] = await Promise.all([
    readCapped(proc.stdout, OUTPUT_CAP),
    readCapped(proc.stderr, OUTPUT_CAP),
    proc.exited,
  ]);

  clearTimeout(timer);

  return { stdout, stderr, exitCode, timedOut };
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (truncated) continue;
    out += decoder.decode(value, { stream: true });
    if (out.length > limit) {
      out = out.slice(0, limit) + `\n[...truncated at ${limit} bytes]`;
      truncated = true;
    }
  }
  if (!truncated) out += decoder.decode();
  return out;
}
