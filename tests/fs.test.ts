import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readTool, writeTool, lsTool, grepTool, findTool } from "../src/tools/fs";
import { WORKSPACE } from "../src/tools/paths";
import { rm, mkdir } from "node:fs/promises";

const SANDBOX = "test-fs-tmp";

async function reset() {
  await rm(`${WORKSPACE}/${SANDBOX}`, { recursive: true, force: true });
  await mkdir(`${WORKSPACE}/${SANDBOX}`, { recursive: true });
}

describe("writeTool", () => {
  beforeEach(reset);
  afterEach(reset);

  test("writes file and returns byte count", async () => {
    const res = await writeTool({ path: `${SANDBOX}/a.txt`, content: "hello" });
    expect(res.bytes).toBe(5);
    expect(await Bun.file(`${WORKSPACE}/${SANDBOX}/a.txt`).text()).toBe("hello");
  });

  test("creates parent directories", async () => {
    await writeTool({ path: `${SANDBOX}/deep/nested/a.txt`, content: "x" });
    expect(await Bun.file(`${WORKSPACE}/${SANDBOX}/deep/nested/a.txt`).text()).toBe("x");
  });

  test("rejects workspace escape", async () => {
    await expect(writeTool({ path: "../escape.txt", content: "" })).rejects.toThrow(/outside workspace/);
  });
});

describe("readTool", () => {
  beforeEach(reset);
  afterEach(reset);

  test("returns numbered lines for text file", async () => {
    await writeTool({ path: `${SANDBOX}/a.txt`, content: "line1\nline2\nline3" });
    const r = await readTool({ path: `${SANDBOX}/a.txt` });
    expect(r.kind).toBe("text");
    if (r.kind !== "text") throw new Error("not text");
    expect(r.text).toContain("     1\tline1");
    expect(r.text).toContain("     3\tline3");
  });

  test("supports offset and limit", async () => {
    const src = Array.from({ length: 10 }, (_, i) => `row${i}`).join("\n");
    await writeTool({ path: `${SANDBOX}/a.txt`, content: src });
    const r = await readTool({ path: `${SANDBOX}/a.txt`, offset: 3, limit: 2 });
    if (r.kind !== "text") throw new Error("not text");
    expect(r.text).toContain("row3");
    expect(r.text).toContain("row4");
    expect(r.text).not.toContain("row5");
    expect(r.text).not.toContain("row2");
  });

  test("returns image base64 + mime for png", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await Bun.write(`${WORKSPACE}/${SANDBOX}/pic.png`, png);
    const r = await readTool({ path: `${SANDBOX}/pic.png` });
    expect(r.kind).toBe("image");
    if (r.kind === "image") {
      expect(r.mime).toBe("image/png");
      expect(r.base64.length).toBeGreaterThan(0);
    }
  });

  test("renders markdown and returns source", async () => {
    await writeTool({ path: `${SANDBOX}/doc.md`, content: "# Title\n\nBody" });
    const r = await readTool({ path: `${SANDBOX}/doc.md` });
    expect(r.kind).toBe("markdown");
    if (r.kind === "markdown") {
      expect(r.source).toContain("# Title");
      expect(r.ansi).toContain("Title");
    }
  });

  test("throws when file missing", async () => {
    await expect(readTool({ path: `${SANDBOX}/nope.txt` })).rejects.toThrow();
  });
});

describe("lsTool", () => {
  beforeEach(reset);
  afterEach(reset);

  test("lists files and directories with kinds", async () => {
    await writeTool({ path: `${SANDBOX}/a.txt`, content: "a" });
    await writeTool({ path: `${SANDBOX}/sub/b.txt`, content: "b" });
    const r = await lsTool({ path: SANDBOX });
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);
    const sub = r.entries.find((e) => e.name === "sub");
    expect(sub?.kind).toBe("dir");
    const a = r.entries.find((e) => e.name === "a.txt");
    expect(a?.kind).toBe("file");
  });

  test("lists workspace root by default", async () => {
    const r = await lsTool({});
    expect(Array.isArray(r.entries)).toBe(true);
  });
});

describe("grepTool", () => {
  beforeEach(reset);
  afterEach(reset);

  test("finds pattern in text files", async () => {
    await writeTool({ path: `${SANDBOX}/a.txt`, content: "needle\nhay" });
    await writeTool({ path: `${SANDBOX}/b.txt`, content: "hay\nhay" });
    const r = await grepTool({ pattern: "needle", path: SANDBOX });
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toContain("a.txt");
  });
});

describe("findTool", () => {
  beforeEach(reset);
  afterEach(reset);

  test("finds files by glob", async () => {
    await writeTool({ path: `${SANDBOX}/x.ts`, content: "" });
    await writeTool({ path: `${SANDBOX}/y.js`, content: "" });
    const r = await findTool({ pattern: "*.ts", path: SANDBOX });
    expect(r.files.length).toBe(1);
    expect(r.files[0]).toContain("x.ts");
  });

  test("rejects glob containing ..", async () => {
    await expect(findTool({ pattern: "../**/*" })).rejects.toThrow(/\.\./);
  });

  test("rejects absolute glob", async () => {
    await expect(findTool({ pattern: "/etc/*" })).rejects.toThrow(/relative/);
  });
});

describe("grepTool glob safety", () => {
  test("rejects glob containing ..", async () => {
    await expect(grepTool({ pattern: "x", glob: "../*" })).rejects.toThrow(/\.\./);
  });
});
