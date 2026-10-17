import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../db.js", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("../../configs/advent.js", () => ({
  ADVENT_DEFAULTS: { roleId: "00000", channelId: "11111", hostId: "22222" },
  ADVENT_BY_GUILD: { "12345": { hostId: "33333" } },
}));
import { getAdventSettings, updateAdventSettings, insertAdventClaim, getAdventClaims } from "../../contests/advent_store.js";

beforeEach(() => mocks.execute.mockResolvedValue([[]]));

describe("Advent persistence", () => {
  it("uses per-guild file defaults until persistent overrides exist", async () => {
    expect(await getAdventSettings("12345")).toEqual({ roleId: "00000", channelId: "11111", hostId: "33333" });
    mocks.execute.mockResolvedValueOnce([[{ role_id: "44444", channel_id: "55555", host_id: "66666" }]]);
    expect(await getAdventSettings("99999")).toEqual({ roleId: "44444", channelId: "55555", hostId: "66666" });
    expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining("WHERE guild_id = ?"), ["99999"]);
  });

  it("patches only the changed field so concurrent updates don't overwrite other settings", async () => {
    await updateAdventSettings({ guildId: "12345", settings: { roleId: "00000", channelId: "11111", hostId: "22222" }, patch: { roleId: "44444" }, updatedBy: "77777" });
    const [sql, params] = mocks.execute.mock.calls[0];
    expect(sql.split("ON DUPLICATE KEY UPDATE")[1]).toContain("role_id = VALUES(role_id)");
    expect(sql.split("ON DUPLICATE KEY UPDATE")[1]).not.toContain("channel_id =");
    expect(params).toEqual(["12345", "44444", "11111", "22222", "77777"]);
  });

  it("distinguishes duplicate claims from database failure", async () => {
    const claim = { guildId: "12345", date: "2026-12-24", userId: "88888", username: "trainer", displayName: "Trainer", claimedAtMs: 123, channelId: "11111", sourceId: "99999" };
    expect(await insertAdventClaim(claim)).toBe(true);
    expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO advent_claims"), ["12345", "2026-12-24", "88888", "trainer", "Trainer", 123, "11111", "99999"]);
    mocks.execute.mockRejectedValueOnce({ code: "ER_DUP_ENTRY" });
    expect(await insertAdventClaim(claim)).toBe(false);
    mocks.execute.mockRejectedValueOnce(new Error("connection lost"));
    await expect(insertAdventClaim(claim)).rejects.toThrow("connection lost");
  });

  it("queries exactly one guild and full date without filtering historical role membership", async () => {
    await getAdventClaims({ guildId: "12345", date: "2025-12-01" });
    expect(mocks.execute).toHaveBeenLastCalledWith(expect.stringContaining("WHERE guild_id = ? AND claim_date = ?"), ["12345", "2025-12-01"]);
  });
});
