import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { targetCwd } from "../src/cwd.ts";

describe("targetCwd", () => {
  test("an absolute path stands, a relative one resolves against its host base", () => {
    expect(targetCwd(tmpdir())).toBe(tmpdir());
    expect(targetCwd(".")).toBe(process.cwd());
    expect(targetCwd(".", tmpdir())).toBe(tmpdir());
  });

  test("~ is the host's home, with or without a path under it", () => {
    expect(targetCwd("~")).toBe(homedir());
    expect(targetCwd("~/")).toBe(homedir());
  });

  test("whatever does not name a directory throws", () => {
    expect(() => targetCwd(resolve(tmpdir(), "key-no-such-dir"))).toThrow(/ENOENT/);
    // This file is a file.
    expect(() => targetCwd(import.meta.filename)).toThrow("not a directory");
  });
});
