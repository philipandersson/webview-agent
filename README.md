# webview-agent

A small CLI agent that uses OpenAI's Responses API + `Bun.WebView` for browser
automation, plus a standalone Hacker News scraper demo.

Built on [Bun 1.3.12+](https://bun.com) — uses `Bun.WebView`, `Bun.markdown.ansi`,
and `Bun.spawn` directly, no extra runtime deps.

## Install

```bash
bun install
```

Create a `.env` (already gitignored):

```
OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-5.4          # optional
```

## Run

Interactive agent CLI:

```bash
bun start
```

Standalone Hacker News scraper demo (opens a headless WebView, extracts the top
5 stories, screenshots each linked page, renders them inline via the Kitty
graphics protocol):

```bash
bun index.ts
```

## Tests

```bash
bun test
bun run typecheck
```

## Layout

```
src/
  cli.ts          # REPL entry: readline loop, SIGINT handling
  agent.ts        # Streaming Responses API + tool-call loop
  prompt.ts       # System prompt + tool cheatsheet
  render.ts       # Terminal UI: markdown, kitty images, tool trace
  tools/
    index.ts      # Tool registry + JSON dispatch
    fs.ts         # read / write / edit / ls / grep / find
    bash.ts       # Shell (cwd=workspace)
    paths.ts      # Workspace sandboxing (safePath)
tests/            # bun:test — fs, edit, bash, paths, agent (with mock client)
workspace/        # Agent's scratchpad (gitignored)
index.ts          # Standalone HN scraper demo
```

## Tools the agent can call

| tool    | purpose                                             |
| ------- | --------------------------------------------------- |
| `read`  | Text (line-numbered), images (shown inline), `.md`  |
| `write` | Create/overwrite a file                             |
| `edit`  | Unique find-and-replace (or `replace_all`)          |
| `ls`    | List directory                                      |
| `grep`  | Ripgrep content search                              |
| `find`  | Ripgrep filename/glob search                        |
| `bash`  | Arbitrary shell command in `workspace/`             |

All paths are resolved via `safePath()` (src/tools/paths.ts), which rejects any
resolution that escapes `workspace/`.

## Security notes

- `.env` and `workspace/` are gitignored.
- `safePath` prevents path traversal via `../`.
- `grep`/`find` use Bun's `$` tagged template — arguments are auto-escaped, no
  shell injection.
- **`bash` runs arbitrary commands**: the sandbox is CWD-only; absolute paths,
  `curl`, `ssh`, `cat ../.env` all work. Treat this as equivalent to giving an
  LLM shell access on your machine. If you point the agent at untrusted web
  content, consider containerizing or adding an allowlist.
