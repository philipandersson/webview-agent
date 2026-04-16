import { test, expect } from "bun:test";
import { requireEnv, envOr, envNum } from "../src/env";

const KEY = "__BUN_WEBVIEW_TEST_ENV__";

test("requireEnv returns the value when present", () => {
  process.env[KEY] = "hi";
  expect(requireEnv(KEY)).toBe("hi");
  delete process.env[KEY];
});

test("requireEnv throws when missing; hint is included", () => {
  delete process.env[KEY];
  expect(() => requireEnv(KEY)).toThrow(new RegExp(KEY));
  expect(() => requireEnv(KEY, "Set it in .env")).toThrow(/Set it in \.env/);
});

test("requireEnv treats empty string as missing", () => {
  process.env[KEY] = "";
  expect(() => requireEnv(KEY)).toThrow();
  delete process.env[KEY];
});

test("envOr returns value when set, fallback when missing or empty", () => {
  process.env[KEY] = "set";
  expect(envOr(KEY, "fb")).toBe("set");
  process.env[KEY] = "";
  expect(envOr(KEY, "fb")).toBe("fb");
  delete process.env[KEY];
  expect(envOr(KEY, "fb")).toBe("fb");
});

test("envNum parses numbers and falls back on invalid", () => {
  process.env[KEY] = "3.14";
  expect(envNum(KEY, 0)).toBe(3.14);
  process.env[KEY] = "not-a-number";
  expect(envNum(KEY, 42)).toBe(42);
  delete process.env[KEY];
  expect(envNum(KEY, 42)).toBe(42);
});
