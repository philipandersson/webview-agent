import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { editTool, writeTool } from "../src/tools/fs";
import { WORKSPACE } from "../src/tools/paths";
import { rm, mkdir } from "node:fs/promises";

const SANDBOX = "test-edit-tmp";
async function reset() {
  await rm(`${WORKSPACE}/${SANDBOX}`, { recursive: true, force: true });
  await mkdir(`${WORKSPACE}/${SANDBOX}`, { recursive: true });
}

describe("editTool", () => {
  beforeEach(reset);
  afterEach(reset);

  test("replaces unique occurrence", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "hello world" });
    const r = await editTool({
      path: `${SANDBOX}/f.txt`,
      old_string: "world",
      new_string: "bun",
    });
    expect(r.replacements).toBe(1);
    expect(await Bun.file(`${WORKSPACE}/${SANDBOX}/f.txt`).text()).toBe("hello bun");
  });

  test("is whitespace-sensitive", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "a\tb" });
    await expect(
      editTool({ path: `${SANDBOX}/f.txt`, old_string: "a b", new_string: "x" }),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when old_string not found", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "abc" });
    await expect(
      editTool({ path: `${SANDBOX}/f.txt`, old_string: "xyz", new_string: "q" }),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when old_string non-unique without replace_all", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "foo foo foo" });
    await expect(
      editTool({ path: `${SANDBOX}/f.txt`, old_string: "foo", new_string: "bar" }),
    ).rejects.toThrow(/non.?unique|multiple/i);
  });

  test("replace_all replaces every occurrence", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "foo foo foo" });
    const r = await editTool({
      path: `${SANDBOX}/f.txt`,
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    expect(r.replacements).toBe(3);
    expect(await Bun.file(`${WORKSPACE}/${SANDBOX}/f.txt`).text()).toBe("bar bar bar");
  });

  test("rejects empty old_string", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "abc" });
    await expect(
      editTool({ path: `${SANDBOX}/f.txt`, old_string: "", new_string: "x" }),
    ).rejects.toThrow(/empty/i);
  });

  test("rejects when old_string equals new_string", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "abc" });
    await expect(
      editTool({ path: `${SANDBOX}/f.txt`, old_string: "abc", new_string: "abc" }),
    ).rejects.toThrow(/identical|no change/i);
  });

  test("preserves surrounding content", async () => {
    await writeTool({ path: `${SANDBOX}/f.txt`, content: "prefix\nMIDDLE\nsuffix" });
    await editTool({
      path: `${SANDBOX}/f.txt`,
      old_string: "MIDDLE",
      new_string: "center",
    });
    expect(await Bun.file(`${WORKSPACE}/${SANDBOX}/f.txt`).text()).toBe("prefix\ncenter\nsuffix");
  });
});
