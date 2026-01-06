import { describe, it, expect, vi, afterEach } from "vitest";

async function loadStorage({ rows = [], executeImpl } = {}) {
  vi.resetModules();

  const execute = vi.fn(executeImpl ?? (async () => [rows]));
  const getDb = vi.fn(() => ({ execute }));
  vi.doMock("../../db.js", () => ({ getDb }));

  const mod = await import("../../rpg/storage.js");
  return { ...mod, execute, getDb };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("rpg/storage", () => {
  it("upsertLeaderboard persists payload JSON", async () => {
    const { upsertLeaderboard, execute } = await loadStorage();

    await upsertLeaderboard({ challenge: "speedtower", payload: { top: 5 } });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO rpg_leaderboards"),
      ["speedtower", JSON.stringify({ top: 5 })]
    );
  });

  it("upsertLeaderboard defaults to empty payload", async () => {
    const { upsertLeaderboard, execute } = await loadStorage();

    await upsertLeaderboard({ challenge: "safarizone" });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO rpg_leaderboards"),
      ["safarizone", "{}"]
    );
  });

  it("getLeaderboard returns null when missing", async () => {
    const { getLeaderboard } = await loadStorage({ rows: [] });

    const result = await getLeaderboard({ challenge: "tc" });

    expect(result).toBeNull();
  });

  it("getLeaderboard returns parsed payload and timestamp", async () => {
    const updatedAt = "2025-01-01T00:00:00.000Z";
    const { getLeaderboard } = await loadStorage({
      rows: [{ challenge: "tc", payload: "{\"count\":5}", updated_at: updatedAt }],
    });

    const result = await getLeaderboard({ challenge: "tc" });

    expect(result).toEqual({
      challenge: "tc",
      payload: { count: 5 },
      updatedAt: new Date(updatedAt).getTime(),
    });
  });

  it("getLeaderboard tolerates invalid JSON payload", async () => {
    const { getLeaderboard } = await loadStorage({
      rows: [{ challenge: "tc", payload: "not-json", updated_at: null }],
    });

    const result = await getLeaderboard({ challenge: "tc" });

    expect(result).toEqual({
      challenge: "tc",
      payload: null,
      updatedAt: null,
    });
  });

  it("upsertPokedexEntry persists payload JSON", async () => {
    const { upsertPokedexEntry, execute } = await loadStorage();

    await upsertPokedexEntry({ entryKey: "pokedex:001-0", payload: { title: "Bulbasaur" } });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO rpg_pokedex"),
      ["pokedex:001-0", JSON.stringify({ title: "Bulbasaur" })]
    );
  });

  it("upsertPokedexEntry strips gender symbols from JSON payload", async () => {
    const { upsertPokedexEntry, execute } = await loadStorage();

    await upsertPokedexEntry({
      entryKey: "pokedex:002-0",
      payload: { sprites: { "normal ♂": "url", "normal ♀": "url2" } },
    });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO rpg_pokedex"),
      ["pokedex:002-0", "{\"sprites\":{\"normal M\":\"url\",\"normal F\":\"url2\"}}"]
    );
  });

  it("getPokedexEntry returns parsed payload and timestamp", async () => {
    const updatedAt = "2025-01-01T00:00:00.000Z";
    const { getPokedexEntry } = await loadStorage({
      rows: [{ entry_key: "pokedex:001-0", payload: "{\"title\":\"Bulbasaur\"}", updated_at: updatedAt }],
    });

    const result = await getPokedexEntry({ entryKey: "pokedex:001-0" });

    expect(result).toEqual({
      entryKey: "pokedex:001-0",
      payload: { title: "Bulbasaur" },
      updatedAt: new Date(updatedAt).getTime(),
    });
  });

  it("incrementLeaderboardHistory upserts win counts", async () => {
    const { incrementLeaderboardHistory, execute } = await loadStorage();

    await incrementLeaderboardHistory({ challenge: "ssanne", trainerId: "123" });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO rpg_leaderboard_history"),
      ["ssanne", "123"]
    );
  });

  it("getLeaderboardHistoryTop returns rows", async () => {
    const rows = [
      { trainer_id: "1", wins: 3 },
      { trainer_id: "2", wins: 1 },
    ];
    const { getLeaderboardHistoryTop, execute } = await loadStorage({ rows });

    const result = await getLeaderboardHistoryTop({ challenge: "ssanne", limit: 2 });

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("FROM rpg_leaderboard_history"),
      ["ssanne"]
    );
    expect(result).toEqual(rows);
  });
});
