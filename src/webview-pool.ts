// Small helpers for parallel, multi-view Bun.WebView workflows.
// Scripts in workspace/scripts can import these via `../src/webview-pool.ts`.

export function timeout(ms: number): Promise<never> {
  return new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
  );
}

export async function navigate(
  view: Bun.WebView,
  url: string,
  ms = 15000,
): Promise<void> {
  await Promise.race([view.navigate(url), timeout(ms)]);
}

// Poll until `selectorExpr` (an expression evaluated in the page, returning
// truthy when ready) resolves truthy, or the timeout fires.
export async function waitFor(
  view: Bun.WebView,
  selectorExpr: string,
  { timeoutMs = 15000, pollMs = 100 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ok = await view.evaluate<unknown>(`!!(${selectorExpr})`);
    if (ok) return;
    await Bun.sleep(pollMs);
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms: ${selectorExpr}`);
}

// Cursor-based pool: N workers pull items until the list is exhausted.
// Preserves result order. Failures inside `worker` propagate — wrap in
// try/catch there if you want partial results, or use parallelMapSettled.
export async function parallelMap<T, R>(
  items: readonly T[],
  poolSize: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (poolSize < 1) throw new Error("poolSize must be >= 1");
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(poolSize, items.length) }, run);
  await Promise.all(workers);
  return out;
}

export type Settled<R> =
  | { ok: true; value: R }
  | { ok: false; error: string };

// "Collect all, flag failures" variant — most fan-out scrapes want this.
// Never rejects; returns one tagged result per input in order.
export async function parallelMapSettled<T, R>(
  items: readonly T[],
  poolSize: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  return parallelMap(items, poolSize, async (item, i) => {
    try {
      return { ok: true, value: await worker(item, i) } as Settled<R>;
    } catch (err) {
      return { ok: false, error: String(err) } as Settled<R>;
    }
  });
}

// Worker-pool variant for many-item fan-outs: spawns K long-lived views once,
// reuses them across all items via navigate(). Prefer this over parallelMap
// when N > ~30 — creating a fresh view per item hits WebKit renderer-spawn
// contention (measured: at N=64, create-per-task degraded to 195s while
// view-reuse stayed at 15s on this host).
//
// Each worker owns one view for its entire run; items are pulled from a
// shared cursor in first-come order. Result order is preserved by index.
export async function parallelWithViews<T, R>(
  items: readonly T[],
  poolSize: number,
  viewOpts: Bun.WebView.ConstructorOptions,
  worker: (view: Bun.WebView, item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (poolSize < 1) throw new Error("poolSize must be >= 1");
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    await using v = new Bun.WebView(viewOpts);
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(v, items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(poolSize, items.length) }, run);
  await Promise.all(workers);
  return out;
}
