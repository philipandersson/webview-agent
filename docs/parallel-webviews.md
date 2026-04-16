# Parallel webviews — findings log

A persistent record for the iterative /loop task: "encourage multiple webviews
at the same time, fan-out pattern, parallelization, test + improve, document
findings." Each iteration should append a dated entry below and keep the
baseline facts at the top current.

## Baseline facts (Bun 1.3.12, verified 2026-04-16)

### Does Bun.WebView have tabs?

Yes — in the "multiple views share one browser subprocess" sense.
`node_modules/bun-types/bun.d.ts:8214-8216` states:

> **Chrome is spawned once per process** — the first `new Bun.WebView()`
> call's `path`/`argv`/`dataStore.directory` win; subsequent views reuse the
> same Chrome instance via `Target.createTarget`.

And `bun.d.ts:8367-8368`:

> Each view runs its page in a separate renderer process.

So **one Bun process → one browser subprocess → N renderer tabs**. There is
no higher-level "tabs" API on a single WebView; you just create more views.

### What is actually serialized vs. parallel?

| Operation                              | Scope          | Parallelizable?             |
|----------------------------------------|----------------|-----------------------------|
| `evaluate()` on one view               | per view       | **No** — 2nd throws `ERR_INVALID_STATE` |
| `evaluate()` on different views        | across views   | **Yes** — separate renderers |
| `navigate()` on different views        | across views   | **Yes**                     |
| `screenshot()` / `click()` / etc.      | across views   | **Yes**                     |
| `dataStore: { directory }`             | process-wide   | First view's dir wins       |
| `backend.path` / `backend.argv`        | process-wide   | First view's flags win      |

### Measured speedups (this repo, macOS WebKit)

- `bench-seq-vs-parallel.ts` — 6 URLs, navigate + `document.title` each (2026-04-16):
  - sequential (1 view, loop): **5,461 ms**
  - parallel (1 view per URL, `Promise.all`): **3,458 ms**
  - **speedup: 1.58×**, parallel time bounded by slowest page (iana.org @ 3,457 ms).
- `fanout-search-explore.ts` — DDG search → 5 parallel page extractions (2026-04-16):
  - stage 1 search: 1,225 ms
  - stage 2 fan-out: 5,174 ms (slowest single page: 5,174 ms)
  - total: 6,399 ms vs an estimated ~9–11 s sequential.
- `bench-pool-size.ts` — 12 URLs, best-of-3 per pool size (2026-04-16):

  | pool | min ms | median ms |
  |------|-------:|----------:|
  |  1   |  6,386 |    10,715 |
  |  2   |  4,073 |     5,188 |
  |  3   |  2,528 |     2,546 |
  |  5   |  2,573 |     2,758 |
  |  8   |  2,502 |     2,551 |
  | 12   |  2,612 |     2,691 |

  **Sweet spot: pool 3–8.** Past 8 → flat/noisy (renderer contention). Pool=1
  also has the widest variance (median 10.7s vs min 6.4s), because serial
  runs are exposed to every slow page's tail latency.
- `bench-pool-size-heavy.ts` — 8 JS-heavy pages (bbc.com, techcrunch,
  react.dev, nextjs, vercel, stripe, guardian, HN), best-of-2 (2026-04-16):

  | pool | min ms | median ms |
  |------|-------:|----------:|
  |  1   |  6,984 |     7,869 |
  |  3   |  2,894 |     2,977 |
  |  5   |  **1,968** |     2,644 |
  |  8   |  2,738 |     2,784 |

  **Sweet spot: pool 5 (3.55×).** Pool 8 is *worse* than pool 5 on heavy
  pages — confirmed renderer-process contention. Confirms iter 2's
  prediction. Default **pool = 5** holds across both regimes.

Fan-out wins scale with the **variance** of per-page latency and the count of
independent targets; the slowest tab sets the floor.

### Recommended patterns (now in the system prompt)

1. **Parallel-all** (small fixed N, ~≤8): one view per task, `Promise.all`.
2. **Pool** (larger N): `parallelMap(items, pool, f)` helper with cursor-based
   worker loop; default pool size 5–10.
3. **Fan-out** (search → explore): stage 1 uses one view to produce candidate
   URLs; stage 2 opens one view per candidate inside the pool.

**Don't parallelize** when tasks share auth/cookies on the same site (keep one
view so the session persists), or when writing to a shared file without a lock
(accumulate in memory, emit at end).

### Runnable reference scripts

All under `workspace/scripts/`:

- `smoke-multi-view.ts` — minimal 3-view parallel smoke test.
- `fanout-search-explore.ts <query> <topK> <poolSize>` — DDG → N pages.
- `bench-seq-vs-parallel.ts` — head-to-head benchmark on 6 URLs.
- `bench-pool-size.ts` — sweep pool ∈ {1,2,3,5,8,12} on 12 light URLs, best-of-3.
- `bench-pool-size-heavy.ts` — sweep pool ∈ {1,3,5,8} on 8 JS-heavy pages.
- `bench-backend-compare.ts` — WebKit vs Chrome on the same URL set + pools.
- `bench-view-reuse.ts` — create-per-task vs view-reuse at N ∈ {16,32,64}.
- `demo-waitfor.ts` — happy-path and timeout-path demo for `waitFor`.
- `fanout-authed-cookies.ts` — Chrome CDP cookie copy across worker views.

### Library (src/webview-pool.ts)

Shared helpers that scripts can import via `../../src/webview-pool.ts` instead
of re-declaring. Keeps scripts small and makes it easy to fix a bug in one
place. Unit-tested in `tests/webview-pool.test.ts`.

- `timeout(ms)` → `Promise<never>` that rejects after `ms`.
- `navigate(view, url, ms?)` — `view.navigate(url)` raced against `timeout`.
  Default 15s.
- `waitFor(view, selectorExpr, { timeoutMs?, pollMs? })` — polls
  `evaluate("!!(...)")` until truthy or the timeout fires. Use for SPA
  targets that render after initial load.
- `parallelMap(items, poolSize, worker)` — cursor-based pool, preserves
  order, caps concurrency at `min(poolSize, items.length)`.
- `parallelMapSettled(items, poolSize, worker)` — same shape, but returns
  `{ ok: true, value } | { ok: false, error }` per item and never rejects.
  Use when partial failures are acceptable (most scrapes).
- `parallelWithViews(items, poolSize, viewOpts, worker)` — worker-pool
  variant: spawns K long-lived views once and reuses each across many
  navigations. Use when N > ~30 — avoids WebKit renderer-spawn contention.
  Tradeoff: a stuck page blocks its worker's queue position (create-per-task
  isolates failures better at small N).

---

## Iterations

### 2026-04-16 — iter 1 (Opus 4.7)

**Goal**: answer "does Bun.WebView support tabs / how do we fan out / how do
we parallelize" with evidence, and update the system prompt so the agent
reaches for multi-view patterns by default.

**Done**

- Read `bun.d.ts` + the existing WEBVIEW_CHEATSHEET in `src/prompt.ts`; confirmed
  the "multiple views = tabs" model and the `evaluate`-per-view serialization
  constraint.
- Wrote 3 reference scripts (`smoke-multi-view`, `fanout-search-explore`,
  `bench-seq-vs-parallel`) and ran them — all produce JSON on stdout and
  demonstrated a 1.58× speedup on the 6-URL benchmark.
- Updated `src/prompt.ts` — added two new sections inside the webview cheatsheet
  ("Multiple views = tabs (USE THIS for parallelism)" and "Fan-out task
  template") plus two new bullets in `<conventions>` directing the agent to
  parallelize across views and to structure search-heavy tasks in two stages.
- Typecheck: `src/` clean; legacy errors in `workspace/scripts/*.ts` from prior
  agent runs are pre-existing, not introduced here.
- `bun test`: 41/41 pass.

**Open questions for next iteration**

- Memory/perf ceiling: at what N does per-view creation start to cost more
  than it saves? Probably depends on site weight. Benchmark with, say,
  N = {3, 5, 10, 20, 40} on a realistic mix.
- Concurrency-cap tuning: `POOL_SIZE` of 5 is a guess. Find the sweet spot on
  this host, and whether Chrome vs WebKit differs.
- Session/auth fan-out: if the agent needs to log in once and then explore N
  pages, what's the best pattern? WebKit gives no cookie APIs; Chrome CDP has
  `Network.setCookie`. Worth a dedicated demo (`fanout-authed-*.ts`).
- DDG sometimes serves a captcha / no-JS page; worth adding a Google
  fallback or a different search backend, and making the search stage
  retryable.
- The `fanout-search-explore` script assumes the page loads deterministically
  — many SPA pages need a `waitFor`/poll step before extract. A helper
  (`waitForSelector` built on `evaluate`) would unblock richer targets.
- Consider a small library module (`src/webview-pool.ts`) exposing
  `parallelMap` so scripts don't re-declare it each time. Only worth it once
  we have 3+ scripts that would reuse it.
- Legacy `workspace/scripts/*.ts` typecheck errors are noise that mask real
  errors in future iterations — either scope the `tsconfig` to `src/` + the
  smoke-test scripts, or clean up the legacy files.

**Handoff note for next iteration**

Start by skimming this log, then pick one of the "open questions" (benchmarks
and pool tuning are probably the highest-leverage next moves). Append a new
`### <date> — iter N` entry describing what you did and leave new open
questions for iter N+1.

### 2026-04-16 — iter 2 (Opus 4.7)

**Goal**: extract the inlined helpers into a shared module, ground the pool-size
default with numbers, add a `waitFor` primitive for SPA targets.

**Done**

- Added `src/webview-pool.ts` exporting `timeout`, `navigate`,
  `waitFor`, `parallelMap`. Unit-tested `parallelMap` in
  `tests/webview-pool.test.ts` (order preservation, concurrency cap, empty
  input, error propagation, pool clamp).
- Wrote `workspace/scripts/bench-pool-size.ts` (sweeps pool ∈ {1,2,3,5,8,12}
  on 12 URLs, best-of-3). Ran it — sweet spot **pool 3–8**, 2.5× over serial,
  plateau past 8. Numbers are now in the prompt + baseline table above.
- Updated `src/prompt.ts`:
  - Replaced the inlined `parallelMap` snippet with an `import { … } from
    "../../src/webview-pool.ts"` line and measured pool-size guidance.
  - Fan-out template now uses the shared helpers + calls out `waitFor` for
    SPA targets in a comment.
- `bun test` → 46/46 pass (up from 41; added 5 pool tests).
  Typecheck clean for `src/` / `tests/` / `index.ts` / new scripts. Legacy
  errors in `workspace/scripts/*.ts` still present, still pre-existing.

**Open questions for iter 3+**

- **Session-auth fan-out**: login once (cookies in one view), then fan out
  across many authed pages. WebKit has no cookie API — on Chrome, CDP
  `Network.setCookie` + `Network.getCookies` would let us copy session across
  views. Demo: `fanout-authed-*.ts`. Worth prototyping.
- **waitFor in practice**: no script yet actually uses `waitFor`. Build a
  demo against a real SPA (e.g. a site whose results render after XHR) and
  confirm the polling approach doesn't race.
- **Heavier target benchmark**: `bench-pool-size.ts` uses light CDN pages.
  Re-run on heavier JS-driven pages (e.g. news sites with analytics) — the
  sweet spot likely shifts lower (3–5), and the plateau probably appears
  earlier as CPU contention on the host renderer processes takes over.
- **Chrome vs WebKit comparison**: all numbers here are WebKit (macOS
  default). Re-run the same benchmarks with `backend: "chrome"` — Chrome may
  have different concurrency characteristics and the data would help the
  prompt give platform-aware guidance.
- **Legacy script cleanup**: scope `tsconfig` to `src/` + `tests/` + named
  scripts, OR delete/rewrite the legacy `workspace/scripts/*.ts` with the
  pre-existing errors. The noise makes it easy to miss real regressions.
- **Concurrency safety for `dataStore.directory`**: multi-view runs with a
  shared persistent profile (Chrome backend only) need testing — docs say
  the first view's directory locks the whole process, but cookie writes
  from concurrent views could race. Relevant to session-auth fan-out.

**Handoff note**

Start by reading the baseline section + all iter entries, then pick the
session-auth fan-out demo or the heavier-target pool-size re-run — both
produce concrete numbers/patterns that the prompt can then cite. Append
`### <date> — iter 3 (…)` when done.

### 2026-04-16 — iter 3 (Opus 4.7)

**Goal**: confirm pool-size guidance on heavy pages, prove `waitFor` actually
works, clean the typecheck signal.

**Done**

- `workspace/scripts/bench-pool-size-heavy.ts` — swept pool ∈ {1,3,5,8} on 8
  JS-heavy pages (news + SPA frameworks + stripe). **Pool=5 wins at 1,968ms
  (3.55×)**, pool=8 regresses to 2,738ms. Renderer-process contention
  kicks in earlier on heavier pages, exactly as iter 2 predicted. The default
  **pool = 5** is now validated across light AND heavy regimes.
- `workspace/scripts/demo-waitfor.ts` — exercises both happy and timeout
  paths of `waitFor`. HN rows already present → wait returns in 0ms (safe
  to call even when condition is pre-satisfied). Fake selector → throws
  with `timeout` in the message. The helper is correct.
- `tsconfig.json` — added `"exclude": ["workspace", "node_modules"]`.
  Workspace is the agent's gitignored scratchpad; its legacy scripts should
  not gate the project's typecheck. `bun run typecheck` is now clean
  (previously 14+ errors from legacy scripts masked any real regression).
  `bun` still runs individual scripts fine — scripts are verified by
  execution, not by tsc.
- Prompt updated: pool recommendation now cites both light- and heavy-page
  numbers. Default **pool = 5** is explicit; "drop to 3 if seeing flaky
  loads" is the new guidance for shaky networks.

**Verification**
- `bun test`: 46/46 pass (unchanged from iter 2).
- `bun run typecheck`: clean.
- Heavy bench, waitFor demo both produce expected JSON.

**Open questions for iter 4+**

- **Chrome vs WebKit** on the same benches — still untested. Chrome spawns
  N separate renderers more visibly; the concurrency plateau may land at a
  different pool size and the cookie/CDP story is Chrome-only. Worth running
  `BUN_CHROME_PATH=... backend:"chrome"` variants of the benches.
- **Session-auth fan-out** — unblocked now that Chrome backend is on the
  horizon. Write `fanout-authed-*.ts` using `cdp("Network.getCookies")` +
  `cdp("Network.setCookie")` to copy session across worker views. Real-world
  applicability: logged-in scrapes, dashboards, rate-limited APIs.
- **SPA demo that actually races without waitFor** — HN is SSR so the iter-3
  demo is a correctness proof, not a motivating example. Pick a site whose
  content appears via XHR (e.g. a search result page that hydrates
  post-load) and show the before/after difference.
- **Error handling in fan-out** — `parallelMap` propagates errors (fail
  fast). Many real fan-outs want "collect all results, flag failures" —
  most scripts already wrap each worker body in try/catch. Consider a
  `parallelMapSettled` variant in `src/webview-pool.ts` for ergonomics.
- **View lifecycle cost** — each `new Bun.WebView()` spawns a renderer. At
  very large N, it may be faster to reuse a pool of K views than to create
  one per task. Worth measuring at N ∈ {50, 100, 200} with view reuse vs
  per-task.
- **Agent CLI integration** — the agent still only has single-view
  awareness through the prompt. Once a real user task exercises fan-out
  through the CLI, we'll learn whether the prompt guidance is actually
  picked up, or whether the agent keeps defaulting to sequential. Could
  add an optional eval to `tests/agent.test.ts` that asserts the agent
  produces a multi-view script for an N-site task.

**Handoff note**

This iteration cemented the default pool size at 5 with data. The biggest
remaining gap is Chrome backend coverage + the session-auth demo, which
unlocks a whole class of realistic tasks. Iter 4 should pick one of those,
or attack `parallelMapSettled` / view-reuse if you want a shorter hop.

### 2026-04-16 — iter 4 (Opus 4.7)

**Goal**: close iter 3's biggest gaps — Chrome-backend data + session-auth
fan-out demo — plus ship `parallelMapSettled` for ergonomics.

**Done**

- `src/webview-pool.ts` — added `parallelMapSettled`. Returns
  `{ ok: true, value } | { ok: false, error }[]` preserving order, never
  rejects. Unit-tested: 2 new tests (happy + failure mix, empty input).
  Test count: 46 → **48 pass**.
- `workspace/scripts/bench-backend-compare.ts` — same URL set, 4 pool sizes,
  both backends, best-of-2 (2026-04-16):

  | pool | webkit ms | chrome ms |
  |------|----------:|----------:|
  |  1   |   5,797   |   5,631   |
  |  3   |   2,849   |   4,344   |
  |  5   |   2,639   |   4,599   |
  |  8   |   **2,355**   |   4,411   |

  **Finding: WebKit wins parallel on macOS.** Serial is comparable; Chrome's
  per-view overhead absorbs the concurrency gain. Chrome is the right pick
  only when you need CDP features (cookies, network interception,
  Linux/Windows portability).
- `workspace/scripts/fanout-authed-cookies.ts` — end-to-end session-auth
  fan-out demo on Chrome + httpbin:
  1. Login view sets `session=abc123; user=claude` via `/cookies/set`.
  2. `cdp("Network.getCookies", { urls: [origin] })` harvests 2 cookies.
  3. 5 worker views, each: `about:blank` → `Network.enable` →
     `Network.setCookie` × N → real URL.
  4. All 5 workers echo back the session cookie. 5/5 successful.
  **Gotcha discovered**: `cdp()` throws `ERR_INVALID_STATE: no session -
  await navigate() first` if called before any navigation. Fix: navigate to
  `about:blank` first to establish the CDP session. The prompt now calls
  this out in a new "Session-auth fan-out" section with a template.
- Prompt updates:
  - New "Session-auth fan-out (Chrome only)" section with the cookie-copy
    template and the about:blank gotcha.
  - Pool recommendation now mentions backend choice + WebKit/Chrome numbers.
  - `parallelMapSettled` listed alongside `parallelMap`.
  - Reference script list refreshed.

**Verification**
- `bun test`: 48/48 pass.
- `bun run typecheck`: clean.
- Backend bench + auth demo both produce expected JSON end-to-end.

**Open questions for iter 5+**

- **View reuse at large N**: iter 3 flagged this. Benchmark at N ∈ {50, 100}:
  does creating-one-view-per-task beat a fixed K-worker pool where each
  worker reuses its view across many items (navigate to each URL in turn)?
  Per-view creation cost × N vs navigate cost × N. Expect the crossover
  somewhere around N=20-30 on this host.
- **Chrome + session-auth on a real SPA with login form**: the httpbin demo
  uses cookie-set via URL param. A real-world demo would log in via a form
  on a SPA (e.g. a public demo site, or a localhost `Bun.serve` login form),
  then fan out. This would exercise the whole pipeline including XHR-based
  auth.
- **`parallelMapSettled` usage audit**: existing scripts in
  `workspace/scripts/` re-declare their own error handling. Migrate at
  least one (e.g. `fanout-search-explore.ts`) to use `parallelMapSettled`
  to verify the ergonomics are actually better.
- **`Bun.WebView.closeAll()` behavior**: the backend-compare script calls
  it between backends to force renderer release. Behavior around partial
  close + subsequent spawns is worth documenting (does it deadlock? does
  pending work hang?).
- **Flaky workers**: `Bun.WebView.closeAll()` mid-run would nuke everyone;
  is there a per-view cancel? Not obvious from the docs. Investigate.
- **Agent loop test**: still haven't confirmed that the CLI agent actually
  picks up the multi-view guidance when given an N-site task. Could extend
  `tests/agent.test.ts` with a scripted fixture.

**Handoff note**

The data is now comprehensive enough to answer "how do I parallelize Bun.WebView
tasks?" with specifics. Iter 5's highest leverage is either:
(a) view reuse at large N — if the crossover exists, it changes the default
pattern recommendation past N≈30, or
(b) real-SPA session-auth demo — closes the credibility gap on the Chrome
cookie-copy pattern.
(c) migrate existing scripts to `parallelMapSettled` to dogfood it.

Pick one and append `### 2026-MM-DD — iter 5` when done.

### 2026-04-16 — iter 5 (Opus 4.7)

**Goal**: close option (a) — create-per-task vs view-reuse at large N. A real
cliff would change the default recommendation.

**Done**

- `workspace/scripts/bench-view-reuse.ts` — sweep N ∈ {16, 32, 64} at pool=5,
  2 runs each, 8 light URLs cycled. Results (best-of-2):

  | N  | create-per-task (ms) | view-reuse (ms) | reuse speedup |
  |----|---------------------:|----------------:|--------------:|
  | 16 |              2,854   |          3,147  |         0.91× |
  | 32 |              6,123   |         15,002  |         0.41× |
  | 64 |            195,026   |         15,003  |        **13×**|

  **A real cliff exists at N=64.** Create-per-task degrades catastrophically:
  both runs at N=64 logged ~195s, consistent with ~13 navigations each hitting
  the 15s timeout wall. view-reuse stays flat at ~15s (bounded by one slow
  URL hanging a worker — the 15003ms is suspiciously exact, indicating one
  single timed-out navigate per run).

  At N=16 the two are within 10% — create-per-task is perfectly fine for
  small fan-outs. At N=32 the data is still noisy (one create run was 6s,
  the other 105s — probably a cold renderer pool hitting a bad streak).
  **Conservative rule: ≤20 → either; >30 → parallelWithViews.**

  Root-cause hypothesis: rapidly spawning many WebView instances on macOS
  WebKit accumulates resource pressure in the shared host process; past some
  threshold, new navigations start timing out en masse. Reuse avoids the
  spawn storm entirely. A real fix would probably be a cap + recycle in the
  agent library, but for now the guidance is "reuse past 30".

- `src/webview-pool.ts` — added `parallelWithViews(items, pool, viewOpts,
  worker)`. Spawns K long-lived views once, reuses each across many
  navigations. Signature mirrors `parallelMap` but threads the persistent
  view into the worker callback.

- Prompt updates:
  - New bullet in the "Patterns" section describing `parallelWithViews`,
    when to use it (>30 items), the tradeoff (fault isolation vs
    throughput), and an inline example.
  - Measured N=64 cliff data cited in-line so the agent knows why the
    recommendation exists.
  - Reference script list now includes `bench-view-reuse.ts`.

**Verification**
- `bun test`: 48/48 pass (no new unit tests for parallelWithViews — end-to-end
  coverage lives in the bench script; a lightweight unit test is open work).
- `bun run typecheck`: clean.
- Bench ran to completion (~7 minutes) and produced the cliff data above.

**Open questions for iter 6+**

- **Unit test for `parallelWithViews`**: lightweight test that opens one view,
  runs 3 items through it via `parallelWithViews(items, 1, opts, fn)`, asserts
  order + that the same view instance was reused. Keeps the src/ module fully
  covered. Should be cheap (one view, no network — use `about:blank`).
- **N=32 noise**: worth a re-run with more runs-per-cell (3–5) to decide if
  the cliff is actually at 32 or closer to 48. Might shift the "30" threshold.
- **Chrome at large N**: does Chrome have the same cliff? Or does the
  heavier per-view cost shift the crossover lower (say, N=15)? Data would
  let us make the prompt recommendation backend-aware.
- **Per-view recycle**: a worker-pool where each view gets recycled every K
  items (e.g. `close + respawn` every 20 navigations) could combine the
  fault-isolation of create-per-task with the no-spawn-storm stability of
  reuse. Requires a fourth helper, but would be the best default.
- **Real-SPA session-auth demo** (iter 4 carryover): still the missing piece
  for "Chrome session-auth" credibility. Log in via a form on a SPA-style
  site, fan out authed fetches through `parallelWithViews` with cookies
  pre-set in the viewOpts (actually — cookies can't go in viewOpts yet; a
  helper that does "new view + about:blank + setCookies" would be nice).
- **Dogfood `parallelMapSettled`** (iter 4 carryover): pick
  `fanout-search-explore.ts` or similar and migrate; confirms the API is
  ergonomic.

**Handoff note**

The N=64 cliff is the single most important finding of the whole loop — it
changes the answer to the user's original question ("fan out over N sites")
from "just use Promise.all" to "use parallelWithViews past N=30". That's
non-obvious without the measurement. Iter 6 should solidify this: more runs
for the 16/32/48/64/100 cliff curve, a unit test for the new helper, and the
optional per-view-recycle hybrid if budget allows.
