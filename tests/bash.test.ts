import { test, expect, describe } from "bun:test";
import { bashTool } from "../src/tools/bash";

describe("bashTool", () => {
  test("captures stdout from simple command", async () => {
    const r = await bashTool({ command: "echo hi" });
    expect(r.stdout.trim()).toBe("hi");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("captures non-zero exit without throwing", async () => {
    const r = await bashTool({ command: "exit 3" });
    expect(r.exitCode).toBe(3);
  });

  test("captures stderr", async () => {
    const r = await bashTool({ command: "echo oops 1>&2" });
    expect(r.stderr.trim()).toBe("oops");
  });

  test("enforces timeout", async () => {
    const r = await bashTool({ command: "sleep 2", timeout_ms: 200 });
    expect(r.timedOut).toBe(true);
  });

  test("runs with workspace as cwd", async () => {
    const r = await bashTool({ command: "pwd" });
    expect(r.stdout).toContain("workspace");
  });
});
