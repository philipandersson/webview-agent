// Centralized env var accessors. Keeps the "process.env.X ?? default" and
// "throw if missing" patterns in one place so callers read like config
// lookups rather than ad-hoc parsing.

export function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  const msg = hint
    ? `${name} is not set. ${hint}`
    : `${name} is not set in the environment`;
  throw new Error(msg);
}

export function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
