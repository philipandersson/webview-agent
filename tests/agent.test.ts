import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Agent } from "../src/agent";
import { WORKSPACE } from "../src/tools/paths";
import { rm, mkdir } from "node:fs/promises";

const SANDBOX = "test-agent-tmp";

async function reset() {
  await rm(`${WORKSPACE}/${SANDBOX}`, { recursive: true, force: true });
  await mkdir(`${WORKSPACE}/${SANDBOX}`, { recursive: true });
}

function makeStreamEvents(events: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

function makeMockClient(responses: any[]) {
  let i = 0;
  return {
    responses: {
      create: async () => {
        const r = responses[i++];
        if (!r) throw new Error("no more mock responses");
        return r;
      },
    },
  };
}

describe("Agent", () => {
  beforeEach(reset);
  afterEach(reset);

  test("dispatches a tool call and feeds result back", async () => {
    const firstOutput = [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "write",
        arguments: JSON.stringify({
          path: `${SANDBOX}/hi.txt`,
          content: "hello",
        }),
      },
    ];

    const secondOutput = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    ];

    const mock = makeMockClient([
      {
        output: firstOutput,
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_item.done", item: firstOutput[0] },
          { type: "response.completed", response: { output: firstOutput } },
        ])[Symbol.asyncIterator],
      },
      {
        output: secondOutput,
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_text.delta", delta: "Done." },
          { type: "response.output_item.done", item: secondOutput[0] },
          { type: "response.completed", response: { output: secondOutput } },
        ])[Symbol.asyncIterator],
      },
    ]);

    const agent = new Agent(mock as any, { silent: true });
    await agent.run("write hello to hi.txt");

    expect(await Bun.file(`${WORKSPACE}/${SANDBOX}/hi.txt`).text()).toBe("hello");

    const last = agent.getLastFinalText();
    expect(last).toBe("Done.");

    const history = agent.getHistory();
    const funcOut = history.find((h: any) => h.type === "function_call_output");
    expect(funcOut).toBeDefined();
    expect((funcOut as any).call_id).toBe("call_1");
  });

  test("throws when stream ends without response.completed", async () => {
    const mock = makeMockClient([
      {
        output: [],
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_text.delta", delta: "partial" },
        ])[Symbol.asyncIterator],
      },
    ]);
    const agent = new Agent(mock as any, { silent: true });
    await expect(agent.run("try")).rejects.toThrow(/completed/i);
  });

  test("dispatches multiple tool calls in parallel within one turn", async () => {
    const firstOutput = [
      {
        type: "function_call",
        id: "fc_a",
        call_id: "call_a",
        name: "bash",
        arguments: JSON.stringify({ command: "sleep 0.3 && echo A" }),
      },
      {
        type: "function_call",
        id: "fc_b",
        call_id: "call_b",
        name: "bash",
        arguments: JSON.stringify({ command: "sleep 0.3 && echo B" }),
      },
      {
        type: "function_call",
        id: "fc_c",
        call_id: "call_c",
        name: "bash",
        arguments: JSON.stringify({ command: "sleep 0.3 && echo C" }),
      },
    ];

    const secondOutput = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "All done." }],
      },
    ];

    const mock = makeMockClient([
      {
        output: firstOutput,
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_item.done", item: firstOutput[0] },
          { type: "response.output_item.done", item: firstOutput[1] },
          { type: "response.output_item.done", item: firstOutput[2] },
          { type: "response.completed", response: { output: firstOutput } },
        ])[Symbol.asyncIterator],
      },
      {
        output: secondOutput,
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_item.done", item: secondOutput[0] },
          { type: "response.completed", response: { output: secondOutput } },
        ])[Symbol.asyncIterator],
      },
    ]);

    const agent = new Agent(mock as any, { silent: true });
    const start = performance.now();
    await agent.run("run three sleeps");
    const elapsed = performance.now() - start;

    // Three 300ms sleeps in parallel should finish well under 600ms (sequential lower bound).
    expect(elapsed).toBeLessThan(600);

    const history = agent.getHistory();
    const outputs = history.filter((h: any) => h.type === "function_call_output");
    expect(outputs.map((o: any) => o.call_id)).toEqual(["call_a", "call_b", "call_c"]);
    for (const o of outputs as any[]) {
      const parsed = JSON.parse(o.output);
      expect(parsed.exitCode).toBe(0);
    }
  });

  test("returns error JSON to model on unknown tool", async () => {
    const firstOutput = [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_x",
        name: "nonsense",
        arguments: "{}",
      },
    ];

    const secondOutput = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Okay." }],
      },
    ];

    const mock = makeMockClient([
      {
        output: firstOutput,
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_item.done", item: firstOutput[0] },
          { type: "response.completed", response: { output: firstOutput } },
        ])[Symbol.asyncIterator],
      },
      {
        output: secondOutput,
        [Symbol.asyncIterator]: makeStreamEvents([
          { type: "response.output_item.done", item: secondOutput[0] },
          { type: "response.completed", response: { output: secondOutput } },
        ])[Symbol.asyncIterator],
      },
    ]);

    const agent = new Agent(mock as any, { silent: true });
    await agent.run("do nothing");

    const history = agent.getHistory();
    const out = history.find((h: any) => h.type === "function_call_output");
    expect(out).toBeDefined();
    const parsed = JSON.parse((out as any).output);
    expect(parsed.error).toMatch(/unknown/i);
  });
});
