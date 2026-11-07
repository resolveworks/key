import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { targetCwd } from "../src/cwd.ts";

describe("targetCwd", () => {
  test("an absolute path stands, a relative one resolves against its host base", () => {
    expect(targetCwd(tmpdir(), undefined)).toBe(tmpdir());
    expect(targetCwd(".", tmpdir())).toBe(tmpdir());
  });

  test("nothing resolves a relative path without a base", () => {
    expect(() => targetCwd(".", undefined)).toThrow("no directory to resolve . against");
  });

  test("~ is the host's home, with or without a path under it", () => {
    expect(targetCwd("~", undefined)).toBe(homedir());
    expect(targetCwd("~/", undefined)).toBe(homedir());
  });

  test("whatever does not name a directory throws", () => {
    expect(() => targetCwd(resolve(tmpdir(), "key-no-such-dir"), undefined)).toThrow(/ENOENT/);
    // This file is a file.
    expect(() => targetCwd(import.meta.filename, undefined)).toThrow("not a directory");
  });
});
