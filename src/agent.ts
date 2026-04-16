import OpenAI from "openai";
import { toolSchemas, dispatch, type DispatchResult } from "./tools";
import { buildSystemPrompt } from "./prompt";
import * as render from "./render";
import { isObject } from "./util";

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ResponseFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall;
type ResponseOutputMessage = OpenAI.Responses.ResponseOutputMessage;

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4";

export type AgentOptions = {
  silent?: boolean;
  model?: string;
};

export type AgentUsage = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export class Agent {
  private client: OpenAI;
  private instructions: string;
  private input: ResponseInputItem[] = [];
  private silent: boolean;
  private model: string;
  private lastFinalText = "";
  private usage: AgentUsage = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(client?: OpenAI, opts: AgentOptions = {}) {
    this.client = client ?? new OpenAI();
    this.instructions = buildSystemPrompt();
    this.silent = opts.silent ?? false;
    this.model = opts.model ?? MODEL;
  }

  getHistory(): ResponseInputItem[] {
    return this.input;
  }

  getLastFinalText(): string {
    return this.lastFinalText;
  }

  getUsage(): AgentUsage {
    return { ...this.usage };
  }

  getModel(): string {
    return this.model;
  }

  async run(userGoal: string): Promise<void> {
    this.input.push({
      role: "user",
      content: [{ type: "input_text", text: userGoal }],
    });
    this.lastFinalText = "";

    for (let turn = 0; turn < 40; turn++) {
      const stream = await this.client.responses.create({
        model: this.model,
        instructions: this.instructions,
        input: this.input,
        tools: toolSchemas,
        parallel_tool_calls: true,
        reasoning: { effort: "low", summary: "auto" },
        stream: true,
      });

      const completedOutput = await this.consumeStream(stream);
      this.input.push(...(completedOutput as ResponseInputItem[]));

      const functionCalls = completedOutput.filter(
        (o): o is ResponseFunctionToolCall => o.type === "function_call",
      );
      if (functionCalls.length === 0) {
        if (!this.silent) render.assistantFlush();
        const lastMsg = [...completedOutput]
          .reverse()
          .find((o): o is ResponseOutputMessage => o.type === "message");
        if (lastMsg) {
          this.lastFinalText = extractMessageText(lastMsg);
        }
        return;
      }

      if (!this.silent) {
        for (const call of functionCalls) {
          render.toolCall(call.name, safeParse(call.arguments));
        }
      }

      const results = await Promise.all(
        functionCalls.map(async (call) => ({
          call,
          result: await dispatch(call.name, call.arguments),
        })),
      );

      for (const { call, result } of results) {
        if (!this.silent) await this.renderToolResult(call.name, result);

        this.input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output:
            typeof result.forModel === "string"
              ? result.forModel
              : JSON.stringify(result.forModel),
        });

        if (result.image) {
          this.input.push({
            role: "user",
            content: [
              {
                type: "input_text",
                text: `(image shown to user from tool "${call.name}" · call_id=${call.call_id})`,
              },
              {
                type: "input_image",
                image_url: `data:${result.image.mime};base64,${result.image.base64}`,
                detail: "auto",
              },
            ],
          });
        }
      }
    }

    if (!this.silent) render.warn("max turns reached; stopping.");
  }

  private async consumeStream(
    stream: AsyncIterable<ResponseStreamEvent>,
  ): Promise<ResponseOutputItem[]> {
    let reasoningOpen = false;
    let textOpen = false;
    let completedOutput: ResponseOutputItem[] = [];
    let sawCompleted = false;

    for await (const event of stream) {
      if (event.type === "response.reasoning_summary_text.delta") {
        if (!reasoningOpen && !this.silent) {
          if (textOpen) {
            render.assistantFlush();
            textOpen = false;
          }
          render.reasoningStart();
          reasoningOpen = true;
        }
        if (!this.silent) render.reasoning(event.delta ?? "");
        continue;
      }

      if (event.type === "response.reasoning_summary_text.done") {
        if (reasoningOpen && !this.silent) {
          render.reasoningEnd();
          reasoningOpen = false;
        }
        continue;
      }

      if (event.type === "response.output_text.delta") {
        if (reasoningOpen && !this.silent) {
          render.reasoningEnd();
          reasoningOpen = false;
        }
        textOpen = true;
        if (!this.silent) render.assistantChunk(event.delta ?? "");
        continue;
      }

      if (event.type === "response.output_text.done") {
        continue;
      }

      if (event.type === "response.output_item.added") {
        if (event.item.type === "reasoning" && !reasoningOpen && !this.silent) {
          if (textOpen) {
            render.assistantFlush();
            textOpen = false;
          }
        }
        continue;
      }

      if (event.type === "response.output_item.done") {
        continue;
      }

      if (event.type === "response.completed") {
        completedOutput = event.response.output ?? [];
        sawCompleted = true;
        const u = event.response.usage;
        if (u) {
          this.usage.turns += 1;
          this.usage.inputTokens += u.input_tokens ?? 0;
          this.usage.outputTokens += u.output_tokens ?? 0;
          this.usage.cachedInputTokens += u.input_tokens_details?.cached_tokens ?? 0;
          this.usage.reasoningTokens += u.output_tokens_details?.reasoning_tokens ?? 0;
        }
        continue;
      }

      if (event.type === "error" || event.type === "response.failed") {
        const msg =
          event.type === "response.failed"
            ? event.response.error?.message ?? "response failed"
            : event.message ?? "unknown stream error";
        if (!this.silent) render.errorLine(`stream error: ${msg}`);
        throw new Error(msg);
      }
    }

    if (reasoningOpen && !this.silent) render.reasoningEnd();
    if (textOpen && !this.silent) render.assistantFlush();
    if (!sawCompleted) {
      throw new Error("stream ended before response.completed event");
    }
    return completedOutput;
  }

  private async renderToolResult(name: string, result: DispatchResult): Promise<void> {
    const fm = result.forModel;

    if (isErrorResult(fm)) {
      render.toolError(String(fm.error));
      return;
    }

    if (result.markdown) {
      render.toolResult(`${name} rendered markdown`);
      render.renderMarkdownAnsi(result.markdown.ansi);
      return;
    }

    if (result.image) {
      const bytes = isObject(fm) && typeof fm.bytes === "number" ? fm.bytes : "";
      render.toolResult(`${name} · image ${bytes} bytes`);
      await render.renderKittyImageFromB64(result.image.base64, result.image.mime);
      return;
    }

    render.toolResult(`${name} · ${summarize(name, fm)}`);
  }
}

function isErrorResult(v: unknown): v is { error: unknown } {
  return isObject(v) && "error" in v;
}

function safeParse(raw: string | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function summarize(name: string, fm: unknown): string {
  if (!isObject(fm)) return String(fm);
  switch (name) {
    case "write":
      return `${fm.bytes} bytes → ${fm.path}`;
    case "edit":
      return `${fm.replacements} replacement(s) in ${fm.path}`;
    case "read":
      return fm.kind === "text" ? `${fm.lines} lines` : JSON.stringify(fm);
    case "ls": {
      const entries = Array.isArray(fm.entries) ? fm.entries.length : 0;
      return `${entries} entries`;
    }
    case "grep": {
      const matches = Array.isArray(fm.matches) ? fm.matches.length : 0;
      return `${matches} matches`;
    }
    case "find": {
      const files = Array.isArray(fm.files) ? fm.files.length : 0;
      return `${files} files`;
    }
    case "bash": {
      const exit = fm.exitCode;
      const to = fm.timedOut ? " timed-out" : "";
      const stdoutLen = typeof fm.stdout === "string" ? fm.stdout.length : 0;
      const stderrLen = typeof fm.stderr === "string" ? fm.stderr.length : 0;
      return `exit=${exit}${to} · ${stdoutLen + stderrLen} bytes output`;
    }
    default:
      return JSON.stringify(fm).slice(0, 120);
  }
}

function extractMessageText(msg: ResponseOutputMessage): string {
  return msg.content
    .filter((p): p is OpenAI.Responses.ResponseOutputText => p.type === "output_text")
    .map((p) => p.text)
    .join("");
}
