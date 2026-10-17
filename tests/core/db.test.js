import { describe, it, expect, vi, afterEach } from "vitest";

const originalEnv = { ...process.env };

async function loadDbModule({ env = {}, pool = null } = {}) {
  vi.resetModules();

  const createPool = vi.fn(() => pool ?? { execute: vi.fn(async () => []) });
  vi.doMock("mysql2/promise", () => ({ default: { createPool } }));

  process.env = { ...originalEnv, ...env };

  const mod = await import("../../db.js");
  return { ...mod, createPool };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe("db.js", () => {
  it("throws when required env vars are missing", async () => {
    const { getDb } = await loadDbModule({ env: { DB_HOST: "", DB_USER: "", DB_NAME: "" } });
    expect(() => getDb()).toThrow(/Missing DB env vars/);
  });

  it("creates and caches pool with parsed numeric fields", async () => {
    const pool = { execute: vi.fn(async () => []) };
    const { getDb, createPool } = await loadDbModule({
      env: {
        DB_HOST: "127.0.0.1",
        DB_PORT: "3307",
        DB_USER: "bot",
        DB_PASSWORD: "pw",
        DB_NAME: "tppc",
        DB_CONNECTION_LIMIT: "5",
      },
      pool,
    });

    const first = getDb();
    const second = getDb();

    expect(first).toBe(pool);
    expect(second).toBe(pool);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 3307,
        user: "bot",
        password: "pw",
        database: "tppc",
        connectionLimit: 5,
        charset: "utf8mb4",
      })
    );
  });

  it("initDb creates tables", async () => {
    const execute = vi.fn(async () => []);
    const pool = { execute };
    const { initDb } = await loadDbModule({
      env: { DB_HOST: "127.0.0.1", DB_USER: "bot", DB_NAME: "tppc" },
      pool,
    });

    await initDb();

    const createStatements = execute.mock.calls.map((call) => call[0]);
    expect(createStatements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS advent_settings/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS advent_claims[\s\S]*PRIMARY KEY \(guild_id, claim_date, user_id\)[\s\S]*DEFAULT CHARACTER SET utf8mb4/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS user_ids/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS user_texts/),
        expect.stringMatching(/ALTER TABLE user_texts/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS rpg_pokedex/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS custom_leaderboards/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS custom_leaderboard_entries/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS goldmarket_settings/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS goldmarket_poll_runs/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS goldmarket_pair_cooldowns/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS goldmarket_scores/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS goldmarket_seed_overrides/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS goldmarket_scheduler_log/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS pokemon_scramble_settings/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS pokemon_scramble_scores/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS trivia_settings/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS trivia_scores/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS loot_settings/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS loot_scores/),
        expect.stringMatching(/ALTER TABLE goldmarket_poll_runs[\s\S]*score_mode/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS notify_me/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS forum_thread_subscriptions/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS reminders/),
        expect.stringMatching(/CREATE TABLE IF NOT EXISTS scheduled_contest_commands/),
      ])
    );
  });

  it.each([0, 2])("converts Advent claim columns only when their charset needs migration (count=%s)", async (legacyColumns) => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("TABLE_NAME = 'advent_claims'")) return [[{ total: legacyColumns }]];
      return [[]];
    });
    const { initDb } = await loadDbModule({
      env: { DB_HOST: "127.0.0.1", DB_USER: "bot", DB_NAME: "tppc" },
      pool: { execute },
    });
    await initDb();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("CHARACTER_SET_NAME <> 'utf8mb4'"), ["tppc"]
    );
    const conversions = execute.mock.calls.filter(([sql]) => sql.includes("ALTER TABLE advent_claims"));
    expect(conversions).toHaveLength(legacyColumns ? 1 : 0);
    if (legacyColumns) expect(conversions[0][0]).toContain("CONVERT TO CHARACTER SET utf8mb4");
  });

  it("does not finish DB initialization if the Advent charset conversion fails", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("TABLE_NAME = 'advent_claims'")) return [[{ total: 1 }]];
      if (sql.includes("ALTER TABLE advent_claims")) throw new Error("migration failed");
      return [[]];
    });
    const { initDb } = await loadDbModule({
      env: { DB_HOST: "127.0.0.1", DB_USER: "bot", DB_NAME: "tppc" },
      pool: { execute },
    });
    await expect(initDb()).rejects.toThrow("migration failed");
  });

  it("wraps CRUD helpers with execute calls", async () => {
    const execute = vi.fn(async () => [[{ saved_id: 42, text: "hi" }]]);
    const pool = { execute };
    const db = await loadDbModule({
      env: { DB_HOST: "127.0.0.1", DB_USER: "bot", DB_NAME: "tppc" },
      pool,
    });

    await db.setSavedId({ guildId: 1, userId: 2, savedId: 3 });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user_ids"),
      ["1", "2", 3]
    );

    const saved = await db.getSavedId({ guildId: 1, userId: 2 });
    expect(saved).toBe(42);

    await db.deleteSavedId({ guildId: 1, userId: 2 });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM user_ids"),
      ["1", "2"]
    );

    await db.setUserText({ guildId: 1, userId: 2, kind: "x", text: "hello" });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user_texts"),
      ["1", "2", "x", "hello"]
    );

    const text = await db.getUserText({ guildId: 1, userId: 2, kind: "x" });
    expect(text).toBe("hi");

    const row = await db.getUserTextRow({ guildId: 1, userId: 2, kind: "x" });
    expect(row).toEqual({ text: "hi", updatedAt: null });

    await db.deleteUserText({ guildId: 1, userId: 2, kind: "x" });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM user_texts"),
      ["1", "2", "x"]
    );
  });
});
