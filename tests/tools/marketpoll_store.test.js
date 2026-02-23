import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("../../db.js", () => ({
  getDb: () => ({ execute }),
}));

import {
  listMarketPollSeedOverrides,
  upsertMarketPollSeedOverride,
  deleteMarketPollSeedOverride,
  countMarketPollSeedOverrides,
  insertMarketPollRun,
  listDueMarketPollRuns,
} from "../../tools/marketpoll_store.js";

describe("marketpoll_store", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("lists seed overrides with mapped fields", async () => {
    execute.mockResolvedValueOnce([
      [
        {
          asset_key: "GoldenAudino|F",
          seed_range: "5kx",
          is_provisional: 1,
          updated_by: "u1",
          created_at: "2026-01-01 00:00:00",
          updated_at: "2026-01-02 00:00:00",
        },
      ],
    ]);

    const rows = await listMarketPollSeedOverrides();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetKey: "GoldenAudino|F",
      seedRange: "5kx",
      isProvisional: true,
      updatedBy: "u1",
    });
    expect(rows[0].updatedAtMs).toBeGreaterThan(0);
  });

  it("upserts and deletes seed overrides", async () => {
    execute.mockResolvedValue([[], []]);
    await upsertMarketPollSeedOverride({
      assetKey: "GoldenAudino|F",
      seedRange: "5kx",
      isProvisional: false,
      updatedBy: "u1",
    });
    await deleteMarketPollSeedOverride({ assetKey: "GoldenAudino|F" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain("INSERT INTO goldmarket_seed_overrides");
    expect(execute.mock.calls[1][0]).toContain("DELETE FROM goldmarket_seed_overrides");
  });

  it("returns seed override count signature fields", async () => {
    execute.mockResolvedValueOnce([
      [
        {
          total: 3,
          latest_updated_at: "2026-02-01 10:00:00",
        },
      ],
    ]);

    const out = await countMarketPollSeedOverrides();
    expect(out.total).toBe(3);
    expect(out.latestUpdatedAtMs).toBeGreaterThan(0);
  });

  it("persists score_mode on poll run inserts and maps it on reads", async () => {
    execute.mockResolvedValueOnce([{ insertId: 22 }]);
    const id = await insertMarketPollRun({
      guildId: "g1",
      channelId: "c1",
      messageId: "m1",
      pairKey: "a||b",
      leftAssetKeys: ["GoldenAudino|F"],
      rightAssetKeys: ["GoldenPichu|G"],
      scoreMode: "exhibition",
      startedAtMs: 1,
      endsAtMs: 2,
    });
    expect(id).toBe(22);
    expect(execute.mock.calls[0][0]).toContain("score_mode");
    expect(execute.mock.calls[0][1]).toContain("exhibition");

    execute.mockResolvedValueOnce([
      [
        {
          id: 1,
          guild_id: "g1",
          channel_id: "c1",
          message_id: "m2",
          pair_key: "a||b",
          left_asset_key: "GoldenAudino|F",
          left_assets_json: '["GoldenAudino|F"]',
          right_asset_key: "GoldenPichu|G",
          right_assets_json: '["GoldenPichu|G"]',
          score_mode: "exhibition",
          started_at_ms: 1,
          ends_at_ms: 2,
        },
      ],
    ]);

    const due = await listDueMarketPollRuns({ nowMs: 999, limit: 1 });
    expect(due).toHaveLength(1);
    expect(due[0].scoreMode).toBe("exhibition");
  });
});
