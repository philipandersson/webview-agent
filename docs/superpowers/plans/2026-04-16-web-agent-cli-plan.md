# Web Agent CLI — Implementation Plan

Build order: scaffold → tests → impl → CLI polish → smoke test. Every step ends with a green `bun test` (or a deliberate skip for smoke-only steps).

## Step 0: Scaffold

1. Write `.env` with the user-supplied `OPENAI_API_KEY`.
2. Add to `.gitignore`: `.env`, `workspace/`, `node_modules`.
3. `bun add openai picocolors`
4. Create directories: `workspace/scripts/`, `workspace/screenshots/`, `src/tools/`, `tests/`.
5. Add scripts to `package.json`: `"start": "bun src/cli.ts"`, `"test": "bun test"`.

Verify: `ls` shows the expected tree, `bun install` happy, `bun test` runs (zero tests OK).

## Step 1: Workspace sandboxing (`src/tools/paths.ts`)

API:
```ts
export const WORKSPACE = path.resolve(process.cwd(), "workspace");
export function safePath(rel: string): string;  // throws on escape
```

Tests (`tests/paths.test.ts`):
- accepts `"foo.txt"`, `"scripts/a.ts"`, `"./bar"`
- rejects `"/etc/passwd"` (absolute)
- rejects `"../etc/passwd"` (escape)
- rejects `"scripts/../../etc/passwd"` (normalized escape)
- returns path under `WORKSPACE`

## Step 2: Filesystem tools (`src/tools/fs.ts`)

Functions (each returns a JSON-serializable value for the agent, or throws):
- `readTool({path, offset?, limit?})` — text: number-prefixed lines; image: `{type: "image", mime, base64, path}`; md: render to ANSI for terminal, return source to model.
- `writeTool({path, content})` — returns `{bytes, path}`.
- `editTool({path, old_string, new_string, replace_all?})` — returns `{replacements, path}`. Throws on not-found, non-unique (unless replace_all), read failure.
- `grepTool({pattern, path?, glob?, output_mode?})` — shells out to `rg`. Parses results, returns array.
- `findTool({pattern, path?})` — `rg --files -g <pattern>` → array of paths.
- `lsTool({path?})` — returns `[{name, kind: "file"|"dir", size?}]`.

Terminal rendering side-effects (images, markdown) happen inside the tool so the CLI layer stays dumb. The tool returns both "what the model sees" and "what the user saw" via a small result wrapper:

```ts
type ToolResult = {
  forModel: unknown;              // serialized into function_call_output
  forModelImage?: { mime, base64 }; // optional separate image input
  display?: () => void;           // side-effect already ran in tool; this is optional
};
```

Actually simpler: tool returns `{forModel, forModelImage?, displayed: true|false}` and the *tool runner* performs the Kitty/markdown rendering before passing `forModel` back. Keep rendering in `render.ts`.

Settled design: tool functions are pure (no I/O to terminal). The tool runner in `agent.ts` invokes them, then calls `render.displayToolResult(...)` which knows how to show images and markdown.

Tests (`tests/fs.test.ts`, `tests/edit.test.ts`):
- read text with offset/limit slices correctly
- read png returns base64 + `mime: "image/png"`
- read md returns `{kind: "markdown", source, ansi}`
- write creates missing parent dir, returns byte count
- ls returns mixed files/dirs with kinds
- edit: exact match single hit succeeds; missing throws `NOT_FOUND`; non-unique throws `NON_UNIQUE`; `replace_all` replaces all
- edit preserves trailing content / whitespace sensitivity

## Step 3: Bash tool (`src/tools/bash.ts`)

```ts
export async function bashTool({ command, cwd?, timeout_ms = 120_000 }): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean;
}>
```

Implementation: `Bun.$` with `.cwd(...)`, `.nothrow()`, `.quiet()`, wrapped in `Promise.race` for timeout. CWD sandboxed via `safePath`.

Tests (`tests/bash.test.ts`):
- runs `echo hi`, captures stdout
- captures non-zero exit without throwing
- enforces timeout (`sleep 5` with `timeout_ms=500` → `timedOut: true`)
- rejects cwd outside workspace

## Step 4: Tool registry (`src/tools/index.ts`)

Export two things:
```ts
export const toolSchemas: ResponsesFunctionTool[] = [...];  // for OpenAI API
export async function dispatch(name: string, args: unknown): Promise<ToolResult>
```

Where `ToolResult` is `{ forModel: unknown; image?: { mime, base64 } }`. Dispatch normalizes errors: catches throws, returns `{ forModel: { error: msg } }` so the model can self-correct.

Schemas include `strict: true` where possible. JSON schema per tool defined inline.

No tests for this module directly — covered by agent.test.ts round-trip.

## Step 5: Render module (`src/render.ts`)

```ts
export function reasoning(text: string): void      // · <dim italic>
export function toolCall(name: string, args: unknown): void  // › name(args)
export function toolResult(summary: string, ok: boolean): void // ✓ / ✗
export function assistantChunk(md: string): void   // buffers, flushes markdown blocks
export function assistantFlush(): void             // flush any buffered assistant text
export function image(bytes: Uint8Array, caption?: string): void  // Kitty
export function markdown(source: string): void     // Bun.markdown.ansi stream-safe
export function goalPrompt(): string               // the `╭─ goal / ╰─› ` prompt string
export function error(msg: string): void
```

Reuses `renderKittyImage` logic from `index.ts`. Uses picocolors. No tests (visual module; eyeball during smoke test).

## Step 6: System prompt (`src/prompt.ts`)

`export const SYSTEM_PROMPT: string;` — built as a template string with the XML-tagged sections from the spec, tool descriptions injected from `toolSchemas`, Bun.WebView cheat-sheet embedded, environment info (cwd, bun version, platform, date) appended at render time via a factory `export function buildSystemPrompt(): string`.

No tests.

## Step 7: Agent loop (`src/agent.ts`)

```ts
export class Agent {
  private client: OpenAI;
  private input: ResponseInputItem[] = [];
  constructor(client?: OpenAI) { ... }
  async run(userGoal: string): Promise<void>   // streams + runs tools until final message
}
```

Algorithm:
1. Append `{role: "user", content: userGoal}` to `input`.
2. Loop:
   a. Call `client.responses.create({ model, instructions, input, tools, reasoning: {effort:"low", summary:"auto"}, stream: true })`.
   b. Consume stream events, dispatching to `render.*`:
      - `response.reasoning_summary_text.delta` → `reasoning(delta)`
      - `response.output_text.delta` → `assistantChunk(delta)`
      - `response.function_call_arguments.done` → note args for item
      - `response.output_item.done` → if reasoning/message/function_call, push to local buffer
      - `response.completed` → take `event.response.output`
   c. After stream ends, append all output items to `input`.
   d. For each `function_call` item:
      - Call `render.toolCall(name, args)`.
      - `dispatch(name, args)` → `{forModel, image?}`.
      - Render result (summary line, plus Kitty image if any).
      - Append `{type: "function_call_output", call_id, output}` to `input`.
      - If `image` present, also append a user message with `input_image` so model can see it on next turn.
   e. If there were no function calls → done, return.
3. Flush assistant output.

Tests (`tests/agent.test.ts`):
- Mock a minimal OpenAI client whose `responses.create` returns a canned async iterable.
- Scenario 1: first response = function_call to `ls`, second response = final message. Verify:
  - `ls` dispatched
  - `function_call_output` appended with correct `call_id`
  - Final message text captured
- Scenario 2: model calls a non-existent tool → error returned in `function_call_output.output`, model gets to retry. Verify error is JSON-stringified error not a thrown exception.

## Step 8: CLI (`src/cli.ts`)

- Greet with banner (a line of dim divider + title)
- Multi-turn loop via `node:readline/promises`
- On each goal: `await agent.run(goal)`
- On `exit` or EOF or two Ctrl-Cs → clean exit
- On single Ctrl-C mid-run: cancel current stream (AbortController), re-prompt

## Step 9: Double-check + smoke test

- `bun test` — all green
- `bun --bun tsc --noEmit` (or `bun x tsc`) — type-clean
- Run `bun start` with a trivial goal like "write hello world to hello.txt" to verify the round-trip without burning much API. Capture any issues.
- Run a real webview goal: "go to news.ycombinator.com and save the top 3 story titles to top.txt". Observe scripts created, screenshots if requested, styled output.

## Acceptance criteria

- `bun test` green
- `bun start` launches, accepts goals, shows reasoning + tool calls + assistant text styled distinctly
- Agent successfully writes a Bun.WebView script in `workspace/scripts/` and runs it to completion
- Screenshots render inline in Kitty-compatible terminals
- Reading a `.md` file shows ANSI-rendered markdown
- Multi-turn works — a second goal references the first
