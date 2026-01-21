import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: fsMocks,
  readFile: fsMocks.readFile,
}));

import { ruleMatches, selectRuleForDate, resolveAvatarChoice, __testables } from "../../avatar_rotation.js";

describe("avatar_rotation", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset();
    __testables.resetState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("matches dates within a single-month range", () => {
    const rule = {
      ranges: [{ start: { month: 9, day: 15 }, end: { month: 9, day: 31 } }],
    };

    expect(ruleMatches(new Date(2024, 9, 20, 12), rule)).toBe(true);
    expect(ruleMatches(new Date(2024, 9, 14, 12), rule)).toBe(false);
  });

  it("matches ranges that wrap across the year boundary", () => {
    const rule = {
      ranges: [{ start: { month: 11, day: 1 }, end: { month: 0, day: 31 } }],
    };

    expect(ruleMatches(new Date(2024, 11, 15, 12), rule)).toBe(true);
    expect(ruleMatches(new Date(2025, 0, 10, 12), rule)).toBe(true);
    expect(ruleMatches(new Date(2025, 1, 1, 12), rule)).toBe(false);
  });

  it("uses the first matching rule as the winner", () => {
    const rules = [
      {
        id: "promo",
        ranges: [{ start: { month: 2, day: 1 }, end: { month: 10, day: 30 } }],
      },
      {
        id: "base",
        ranges: [{ start: { month: 9, day: 15 }, end: { month: 9, day: 31 } }],
      },
    ];

    const rule = selectRuleForDate(new Date(2024, 9, 20, 12), rules);
    expect(rule?.id).toBe("promo");
  });

  it("prefers an override path when provided", () => {
    const rules = [
      {
        id: "base",
        ranges: [{ start: { month: 0, day: 1 }, end: { month: 11, day: 31 } }],
        file: "assets/avatars/standard.png",
      },
    ];

    const choice = resolveAvatarChoice(new Date(2024, 0, 5, 12), {
      overridePath: "assets/avatars/dev_override.png",
      rules,
    });

    expect(choice).toEqual({ file: "assets/avatars/dev_override.png", ruleId: "override" });
  });

  it("schedules the next check for the upcoming ET midnight window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-14T11:12:10Z"));

    const delay = __testables.computeNextDelayMs();
    expect(delay).toBeGreaterThan(6 * 60 * 60 * 1000);
    expect(delay).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("schedules the next check shortly after 00:01 ET when near midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-14T04:59:30Z"));

    const delay = __testables.computeNextDelayMs();
    expect(delay).toBeGreaterThan(60 * 1000);
    expect(delay).toBeLessThan(5 * 60 * 1000);
  });

  it("maps a 00:01 ET local time to the correct UTC instant", () => {
    const target = __testables.makeZonedDate(
      { year: 2026, month: 1, day: 14, hour: 0, minute: 1, second: 0 },
      "America/New_York"
    );
    expect(target.toISOString()).toBe("2026-01-14T05:01:00.000Z");
  });

  it("normalizes 24:xx to 00:xx for the same day in ET", () => {
    const parts = __testables.getZonedParts(new Date("2026-01-14T05:01:00Z"), "America/New_York");
    expect(parts).toEqual({ month: 1, day: 14, year: 2026, hour: 0, minute: 1, second: 0 });
  });

  it("retries once on socket-closed errors when setting avatar", async () => {
    vi.useFakeTimers();
    fsMocks.readFile.mockResolvedValue(Buffer.from("avatar"));

    const setAvatar = vi
      .fn()
      .mockRejectedValueOnce({ name: "SocketError", message: "other side closed" })
      .mockResolvedValueOnce(undefined);
    const client = { user: { setAvatar } };

    const prev = process.env.AVATAR_OVERRIDE;
    process.env.AVATAR_OVERRIDE = "assets/avatars/default_flipped.png";

    const promise = __testables.applyAvatar(client, "startup");
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(setAvatar).toHaveBeenCalledTimes(2);

    process.env.AVATAR_OVERRIDE = prev;
  });

  it("does not retry on non-socket errors", async () => {
    fsMocks.readFile.mockResolvedValue(Buffer.from("avatar"));

    const setAvatar = vi
      .fn()
      .mockRejectedValueOnce({ name: "DiscordAPIError", message: "bad request" });
    const client = { user: { setAvatar } };

    const prev = process.env.AVATAR_OVERRIDE;
    process.env.AVATAR_OVERRIDE = "assets/avatars/default_flipped.png";

    await __testables.applyAvatar(client, "startup");

    expect(setAvatar).toHaveBeenCalledTimes(1);

    process.env.AVATAR_OVERRIDE = prev;
  });
});
