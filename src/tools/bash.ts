import { WORKSPACE } from "./paths";

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
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  return { stdout, stderr, exitCode, timedOut };
}
