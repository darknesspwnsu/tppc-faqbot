import { describe, it, expect } from "vitest";

import { parseDurationSeconds, formatDurationSeconds } from "../../shared/time_utils.js";

describe("time_utils", () => {
  it("parses duration strings", () => {
    expect(parseDurationSeconds("30")).toBe(30);
    expect(parseDurationSeconds("10s")).toBe(10);
    expect(parseDurationSeconds("2sec")).toBe(2);
    expect(parseDurationSeconds("5m")).toBe(300);
    expect(parseDurationSeconds("1minute")).toBe(60);
    expect(parseDurationSeconds("2h")).toBe(7200);
    expect(parseDurationSeconds("3hours")).toBe(10800);
    expect(parseDurationSeconds("bad")).toBe(null);
  });

  it("uses default when input is empty", () => {
    expect(parseDurationSeconds("", 7)).toBe(7);
    expect(parseDurationSeconds(null, 5)).toBe(5);
  });

  it("formats durations", () => {
    expect(formatDurationSeconds(10)).toBe("10s");
    expect(formatDurationSeconds(0)).toBe("NONE");
  });
});
