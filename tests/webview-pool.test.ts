import { test, expect } from "bun:test";
import { parallelMap, parallelMapSettled, parallelWithViews } from "../src/webview-pool";

test("parallelMap preserves order and caps concurrency", async () => {
  const inflight = { now: 0, max: 0 };
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const out = await parallelMap(items, 3, async (x) => {
    inflight.now++;
    inflight.max = Math.max(inflight.max, inflight.now);
    await Bun.sleep(10 + (x % 3) * 5);
    inflight.now--;
    return x * 2;
  });
  expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  expect(inflight.max).toBeLessThanOrEqual(3);
  expect(inflight.max).toBeGreaterThanOrEqual(2);
});

test("parallelMap handles empty input", async () => {
  const out = await parallelMap([], 5, async () => 1);
  expect(out).toEqual([]);
});

test("parallelMap rejects poolSize < 1", async () => {
  await expect(parallelMap([1], 0, async (x) => x)).rejects.toThrow("poolSize");
});

test("parallelMap caps workers at items.length when pool > items", async () => {
  let spawned = 0;
  await parallelMap([1, 2], 10, async () => {
    spawned++;
    return null;
  });
  // Only 2 items → at most 2 worker loops ran.
  expect(spawned).toBe(2);
});

test("parallelMap propagates errors from worker", async () => {
  await expect(
    parallelMap([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    }),
  ).rejects.toThrow("boom");
});

test("parallelMapSettled collects all, flags failures, preserves order", async () => {
  const out = await parallelMapSettled([1, 2, 3, 4], 2, async (x) => {
    if (x === 2) throw new Error("boom");
    if (x === 4) throw new Error("bam");
    return x * 10;
  });
  expect(out).toEqual([
    { ok: true, value: 10 },
    { ok: false, error: "Error: boom" },
    { ok: true, value: 30 },
    { ok: false, error: "Error: bam" },
  ]);
});

test("parallelMapSettled never rejects for empty input", async () => {
  const out = await parallelMapSettled([], 5, async () => 1);
  expect(out).toEqual([]);
});

test("parallelWithViews reuses one view across items, preserves order", async () => {
  const items = ["a", "b", "c", "d"];
  const seen: Bun.WebView[] = [];
  const out = await parallelWithViews(
    items,
    1,
    { width: 400, height: 300 },
    async (view, item, i) => {
      seen.push(view);
      await Promise.race([
        view.navigate("about:blank"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("nav timeout")), 5000)),
      ]);
      return `${item}:${i}`;
    },
  );
  expect(out).toEqual(["a:0", "b:1", "c:2", "d:3"]);
  // Single worker → all calls share one view instance.
  expect(new Set(seen).size).toBe(1);
  expect(seen.length).toBe(items.length);
});

test("parallelWithViews caps concurrency to pool size", async () => {
  const inflight = { now: 0, max: 0 };
  const items = [0, 1, 2, 3, 4, 5];
  await parallelWithViews(
    items,
    2,
    { width: 400, height: 300 },
    async (_view, x) => {
      inflight.now++;
      inflight.max = Math.max(inflight.max, inflight.now);
      await Bun.sleep(20 + (x % 3) * 10);
      inflight.now--;
      return x;
    },
  );
  expect(inflight.max).toBe(2);
});

test("parallelWithViews rejects poolSize < 1", async () => {
  await expect(
    parallelWithViews([1], 0, { width: 400, height: 300 }, async () => null),
  ).rejects.toThrow("poolSize");
});
