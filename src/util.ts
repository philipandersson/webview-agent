export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
