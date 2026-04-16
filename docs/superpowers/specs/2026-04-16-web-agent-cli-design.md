# Web Agent CLI — Design

A multi-turn CLI that spawns an OpenAI-powered agent which achieves user goals by writing and running Bun TypeScript scripts that drive `Bun.WebView` for browser automation. Scripts are saved in a workspace and are re-runnable.

## Goals

- Take a user goal on the CLI, inject into the user message, let the agent plan and execute
- Agent writes deterministic, re-runnable Bun scripts (not black-box tool calls to a live webview)
- Show reasoning, tool calls, tool results, and assistant text with distinct, tasteful styling
- Render screenshots and other images inline in the terminal (Kitty graphics protocol)
- Render markdown files and assistant markdown text through Bun's ANSI markdown renderer
- Multi-turn: conversation history and the workspace persist across goals in one session

## Non-goals

- Registering the webview as a live tool. We intentionally avoid this so every action is captured as a script.
- Using the OpenAI Agents SDK. Plain `openai` Node SDK only.
- Cross-session memory beyond what's on disk in `workspace/`.

## Model

- `gpt-5.4` via `client.responses.create(...)`
- `reasoning: { effort: "low", summary: "auto" }`
- Streaming enabled
- System prompt via `instructions` field

## Layout

```
.env                              # OPENAI_API_KEY
workspace/                        # agent's sandbox. All tools scoped here.
  scripts/                        # agent-authored Bun scripts
  screenshots/                    # screenshots saved by scripts
src/
  tools/
    index.ts                      # registry: JSON schema + dispatcher
    fs.ts                         # read, write, edit, grep, find, ls
    bash.ts                       # Bun.$ execution
    paths.ts                      # workspace sandboxing helper
  agent.ts                        # OpenAI Responses loop (streaming)
  render.ts                       # Kitty image + picocolors styling
  prompt.ts                       # XML-tagged system prompt
  cli.ts                          # multi-turn REPL entry point
tests/
  paths.test.ts
  fs.test.ts
  edit.test.ts
  bash.test.ts
  agent.test.ts                   # with mocked OpenAI client
```

## Tools

All tools are sandboxed to `workspace/`. Absolute paths and `..` escapes are rejected with a clear error.

| Tool | Params | Behavior |
|---|---|---|
| `read` | `{path, offset?, limit?}` | Text returned with `cat -n` style line numbers. Images (png/jpg/webp/gif) base64-returned to model as `input_image` AND rendered in terminal via Kitty. `.md` files rendered via `Bun.markdown.ansi` AND source returned to model. |
| `write` | `{path, content}` | Overwrite. Parent dirs created as needed. |
| `edit` | `{path, old_string, new_string, replace_all?}` | Exact match (whitespace-sensitive). Error if not found or non-unique (unless `replace_all`). |
| `bash` | `{command, cwd?, timeout_ms?}` | Runs inside workspace. 120s default timeout. Returns `{stdout, stderr, exitCode}`. |
| `grep` | `{pattern, path?, glob?, output_mode?}` | Via `rg`. Respects `.gitignore` by default. |
| `find` | `{pattern, path?}` | `rg --files -g <pattern>`. Respects `.gitignore`. |
| `ls` | `{path?}` | One entry per line with `/` suffix for dirs. |

### Edit tool format decision

Research favors Aider-style SEARCH/REPLACE freeform over JSON-escaped `old_string`/`new_string` (JSON escaping degrades code-in-string accuracy a few points on GPT benchmarks). We still use the JSON schema for simpler streaming and dispatch, but make the contract strict:
- `old_string` must match exactly, including whitespace.
- `old_string` must be unique in the file unless `replace_all=true`.
- System prompt teaches with two examples.

## System prompt (XML-tagged)

```
<role>…web agent that achieves the user's goal by writing and running Bun TypeScript scripts that use Bun.WebView…</role>
<environment>cwd=workspace/, bun version, platform, today's date</environment>
<tools>
  <tool name="..." description="...">{ json params schema }</tool>
  ...one per tool
</tools>
<webview_api>
  Full Bun.WebView cheat sheet: constructor options, every method with signatures,
  evaluate gotchas (single-expression, one-at-a-time, serialization rules),
  screenshot options, event callbacks, `await using` pattern, CDP access on Chrome,
  backend differences (webkit default macOS, chrome elsewhere), plus a short
  illustrative script example.
</webview_api>
<workflow>
  1. Plan in your head
  2. Write a script to workspace/scripts/<slug>.ts
  3. Run it with `bun workspace/scripts/<slug>.ts`
  4. Read output / read screenshots
  5. Iterate
  6. Keep scripts small, focused, and re-runnable
</workflow>
<conventions>
  - await using view = new Bun.WebView({ width, height })
  - Only one evaluate() at a time per view
  - Wrap statements in IIFE for evaluate()
  - Save screenshots to workspace/screenshots/
  - Navigate timeouts: wrap navigate() with Promise.race
</conventions>
<edit_rules>
  - old_string must match EXACTLY including whitespace
  - old_string must be unique unless you set replace_all=true
  - Prefer small targeted edits over rewriting files
</edit_rules>
```

## CLI UX (Bun-inspired aesthetic)

Quiet, monospace, punctuation-driven. Palette uses dim gray for secondary content, cyan accents for tool names, soft white for primary, no loud colors.

- Reasoning delta: `·` + dim italic gray text, streamed
- Tool call: `›` + cyan `tool.name` + short args preview on same line; long args dim-printed underneath
- Tool result: single-line summary (`✓ 3 files` / `✓ 142 bytes` / `✗ error: ...`), dim; expanded only on error
- Assistant text: rendered through `Bun.markdown.ansi({ hyperlinks: true, kittyGraphics: true })`, streamed by buffering per paragraph (markdown needs whole blocks to format, so we flush on blank line or end)
- Screenshot inline render: Kitty graphics protocol with one-line caption `📸 workspace/screenshots/foo.png`
- Goal prompt: `╭─ goal` / `╰─› ` — bold white, readline via `node:readline/promises`

## Multi-turn state

- Same `workspace/` directory persists across goals
- Same OpenAI `input[]` array accumulates across goals (conversation history)
- The webview doesn't persist directly — it lives inside whichever script the agent runs, so a script opens and disposes the view per invocation. The agent can design longer-lived flows by chaining scripts or using `dataStore: { directory: "..." }` for persistent cookies.
- `exit` or Ctrl-D quits

## Multi-turn semantics

When the user enters a new goal, we append a new `{role: "user", content: <goal>}` to the `input[]` array and call `responses.create` again with full history. Reasoning items from prior turns are included so the model keeps chain-of-thought continuity.

## Error handling

- Tool errors returned to the model as `{error: <message>}` JSON so it can self-correct
- OpenAI API errors retried once with exponential backoff, then surfaced to user
- Ctrl-C during a streaming response cancels the stream, flushes partial output, returns to the goal prompt without ending the session
- Ctrl-C a second time exits cleanly

## Testing strategy

TDD with `bun test`:

- `paths.test.ts` — sandbox rejects `..`, absolute paths outside workspace; resolves safely
- `fs.test.ts` — read with offset/limit, read image returns base64 + mime, write creates parent dirs, ls formats
- `edit.test.ts` — exact match success, whitespace sensitivity, not-found error, non-unique error, `replace_all` path
- `bash.test.ts` — stdout/stderr/exitCode captured, cwd sandboxed, timeout enforced
- `agent.test.ts` — mock `client.responses.create` to yield a canned stream with a function_call + final message. Verify tool was dispatched and result fed back. Covers one full tool-calling round-trip.

## Dependencies

- `openai` (latest)
- `picocolors`
- Bun built-ins for everything else (`.env`, `$`, `file`, `markdown.ansi`, `WebView`, `readline/promises`)

## Open questions resolved

1. Model: `gpt-5.4`, reasoning effort `low`.
2. Screenshots to model: yes, both terminal render and `input_image` to model.
3. Webview tools registered: no, agent writes Bun scripts instead.
4. Workspace sandboxing: all tools scoped to `workspace/`.
5. Markdown rendering: use `Bun.markdown.ansi` for `.md` reads and assistant markdown output.
