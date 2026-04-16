import path from "node:path";

export const WORKSPACE = path.resolve(process.cwd(), "workspace");

export function safePath(rel: string): string {
  if (rel === "" || rel === ".") return WORKSPACE;

  const candidate = path.resolve(WORKSPACE, rel);
  const prefix = WORKSPACE + path.sep;

  if (candidate !== WORKSPACE && !candidate.startsWith(prefix)) {
    throw new Error(`path "${rel}" resolves outside workspace`);
  }

  return candidate;
}
