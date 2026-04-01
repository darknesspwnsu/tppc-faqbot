import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: fsMocks,
  readFile: fsMocks.readFile,
}));

import {
  ruleMatches,
  selectRuleForDate,
  resolveAvatarChoice,
  resolveIdentityChoice,
  __testables,
} from "../../avatar_rotation.js";

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

  it("matches rules against ET instead of the machine local timezone", () => {
    const rule = {
      ranges: [{ start: { month: 3, day: 1 }, end: { month: 3, day: 1 } }],
    };

    expect(ruleMatches(new Date("2026-04-01T04:43:00.000Z"), rule)).toBe(true);
    expect(ruleMatches(new Date("2026-04-01T03:43:00.000Z"), rule)).toBe(false);
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

  it("resolves nickname from the matched rule", () => {
    const rules = [
      {
        id: "april_fools",
        ranges: [{ start: { month: 3, day: 1 }, end: { month: 3, day: 1 } }],
        file: "assets/avatars/april_fools.png",
        nickname: "Glaceon",
      },
      {
        id: "default",
        ranges: [{ start: { month: 0, day: 1 }, end: { month: 11, day: 31 } }],
        file: "assets/avatars/default.png",
        nickname: "Spectreon",
      },
    ];

    const choice = resolveIdentityChoice(new Date(2026, 3, 1, 12), { rules });
    expect(choice).toEqual({
      file: "assets/avatars/april_fools.png",
      nickname: "Glaceon",
      ruleId: "april_fools",
    });
  });

  it("falls back to the deployment default nickname when the rule has no nickname", () => {
    const rules = [
      {
        id: "default",
        ranges: [{ start: { month: 0, day: 1 }, end: { month: 11, day: 31 } }],
        file: "assets/avatars/default.png",
      },
    ];

    const choice = resolveIdentityChoice(new Date(2026, 3, 2, 12), {
      rules,
      defaultNickname: "Spectreon (Dev)",
    });
    expect(choice).toEqual({
      file: "assets/avatars/default.png",
      nickname: "Spectreon (Dev)",
      ruleId: "default",
    });
  });

  it("prefers the nickname override over other nickname settings", () => {
    const rules = [
      {
        id: "april_fools",
        ranges: [{ start: { month: 3, day: 1 }, end: { month: 3, day: 1 } }],
        file: "assets/avatars/april_fools.png",
        nickname: "Glaceon",
      },
    ];

    const choice = resolveIdentityChoice(new Date(2026, 3, 1, 12), {
      rules,
      overrideNickname: "Spectreon (Dev)",
      defaultNickname: "Spectreon",
    });
    expect(choice).toEqual({
      file: "assets/avatars/april_fools.png",
      nickname: "Spectreon (Dev)",
      ruleId: "april_fools",
    });
  });

  it("defaults to Spectreon when no deployment nickname is set", () => {
    const rules = [
      {
        id: "default",
        ranges: [{ start: { month: 0, day: 1 }, end: { month: 11, day: 31 } }],
        file: "assets/avatars/default.png",
      },
    ];

    const choice = resolveIdentityChoice(new Date(2026, 3, 2, 12), {
      rules,
      defaultNickname: undefined,
    });
    expect(choice).toEqual({
      file: "assets/avatars/default.png",
      nickname: "Spectreon",
      ruleId: "default",
    });
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

  it("updates guild nicknames for the matching rule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T16:00:00Z"));

    const setNicknameA = vi.fn(async () => {});
    const setNicknameB = vi.fn(async () => {});
    const client = {
      user: { id: "user1" },
      guilds: {
        cache: new Map([
          ["g1", { id: "g1", members: { me: { nickname: "Spectreon", setNickname: setNicknameA } } }],
          ["g2", { id: "g2", members: { me: { nickname: null, setNickname: setNicknameB } } }],
        ]),
      },
    };

    await __testables.applyNickname(client, "startup");

    expect(setNicknameA).toHaveBeenCalledWith("Glaceon");
    expect(setNicknameB).toHaveBeenCalledWith("Glaceon");
  });

  it("skips guild nickname updates that are already current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T16:00:00Z"));

    const prevDefaultNickname = process.env.BOT_DEFAULT_NICKNAME;
    process.env.BOT_DEFAULT_NICKNAME = "Spectreon (Dev)";

    const setNickname = vi.fn(async () => {});
    const client = {
      user: { id: "user1" },
      guilds: {
        cache: new Map([
          ["g1", { id: "g1", members: { me: { nickname: "Spectreon (Dev)", setNickname } } }],
        ]),
      },
    };

    await __testables.applyNickname(client, "scheduled");

    expect(setNickname).not.toHaveBeenCalled();

    if (prevDefaultNickname == null) {
      delete process.env.BOT_DEFAULT_NICKNAME;
    } else {
      process.env.BOT_DEFAULT_NICKNAME = prevDefaultNickname;
    }
  });
});
