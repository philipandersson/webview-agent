import { test, expect, describe } from "bun:test";
import { safePath, WORKSPACE } from "../src/tools/paths";

describe("safePath", () => {
  test("accepts relative filename", () => {
    expect(safePath("foo.txt")).toBe(`${WORKSPACE}/foo.txt`);
  });

  test("accepts nested relative path", () => {
    expect(safePath("scripts/a.ts")).toBe(`${WORKSPACE}/scripts/a.ts`);
  });

  test("accepts leading dot-slash", () => {
    expect(safePath("./bar")).toBe(`${WORKSPACE}/bar`);
  });

  test("accepts path that normalizes inside workspace", () => {
    expect(safePath("scripts/./a.ts")).toBe(`${WORKSPACE}/scripts/a.ts`);
  });

  test("rejects absolute path outside workspace", () => {
    expect(() => safePath("/etc/passwd")).toThrow(/outside workspace/);
  });

  test("rejects parent-directory escape", () => {
    expect(() => safePath("../etc/passwd")).toThrow(/outside workspace/);
  });

  test("rejects nested escape that normalizes out", () => {
    expect(() => safePath("scripts/../../etc/passwd")).toThrow(/outside workspace/);
  });

  test("accepts empty path as workspace root", () => {
    expect(safePath("")).toBe(WORKSPACE);
  });

  test("accepts dot as workspace root", () => {
    expect(safePath(".")).toBe(WORKSPACE);
  });
});
