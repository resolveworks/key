import { describe, expect, test } from "vitest";
import { cycleRunning } from "../src/client.ts";
import type { Summary } from "../src/host.ts";

const summary = (id: number, running: boolean): Summary => ({
  id,
  label: `ask ${id}`,
  cwd: "/key/repo",
  running,
});

// The host lists newest first; parked contexts stay in the list but never in the ring.
const summaries = [summary(5, true), summary(4, false), summary(3, true), summary(1, true)];

describe("cycleRunning", () => {
  test("from a running context it steps to the running neighbor, wrapping both ways", () => {
    expect(cycleRunning(summaries, 5, 1)).toBe(3);
    expect(cycleRunning(summaries, 3, 1)).toBe(1);
    expect(cycleRunning(summaries, 1, 1)).toBe(5);
    expect(cycleRunning(summaries, 5, -1)).toBe(1);
    expect(cycleRunning(summaries, 1, -1)).toBe(3);
    expect(cycleRunning(summaries, 3, -1)).toBe(5);
  });

  test("from any other view it lands on the first running forward, the last backward", () => {
    expect(cycleRunning(summaries, undefined, 1)).toBe(5);
    expect(cycleRunning(summaries, undefined, -1)).toBe(1);
    expect(cycleRunning(summaries, 4, 1)).toBe(5);
    expect(cycleRunning(summaries, 4, -1)).toBe(1);
  });

  test("a lone running context is its own neighbor", () => {
    expect(cycleRunning([summary(4, false), summary(3, true)], 3, 1)).toBe(3);
    expect(cycleRunning([summary(4, false), summary(3, true)], 3, -1)).toBe(3);
  });

  test("with nothing running there is nowhere to go", () => {
    const parked = [summary(2, false), summary(1, false)];
    expect(cycleRunning(parked, undefined, 1)).toBeUndefined();
    expect(cycleRunning(parked, 1, -1)).toBeUndefined();
  });
});
