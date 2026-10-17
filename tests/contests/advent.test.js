import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { ADVENT_DEV_BOT_ID } from "../../configs/advent.js";

const mocks = vi.hoisted(() => ({
  getAdventSettings: vi.fn(), updateAdventSettings: vi.fn(), insertAdventClaim: vi.fn(), getAdventClaims: vi.fn(),
  isAdminOrPrivileged: vi.fn(), sendDm: vi.fn(), error: vi.fn(),
}));
vi.mock("../../contests/advent_store.js", () => mocks);
vi.mock("../../auth.js", () => ({ isAdminOrPrivileged: mocks.isAdminOrPrivileged }));
vi.mock("../../shared/dm.js", () => ({ sendDm: mocks.sendDm }));
vi.mock("../../shared/logger.js", () => ({ logger: { error: mocks.error, serializeError: (err) => err.message } }));

const SETTINGS = { roleId: "55555", channelId: "66666", hostId: "77777" };
let handlers, slash, settings, claims, __testables;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function member(id = "88888", roleIds = [SETTINGS.roleId]) {
  return { id, displayName: "Trainer", user: { id, username: "trainer", bot: false }, roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } };
}

function source({ userId = "88888", guildId = "12345", channelId = "66666", timestamp = Date.now(), type = ChannelType.PublicThread } = {}) {
  const actor = member(userId);
  const channel = { id: channelId, type, isThread: () => [10, 11, 12].includes(type) };
  const src = {
    id: "999999999999999999", guildId, channelId, channel, createdTimestamp: timestamp,
    user: actor.user, author: actor.user, member: actor,
    guild: {
      id: guildId, name: "Test server",
      members: { fetch: vi.fn(async () => actor) },
      roles: { fetch: vi.fn(async (id) => ({ id })) },
      channels: { fetch: vi.fn(async () => channel) },
    },
    reply: vi.fn(async () => ({})), editReply: vi.fn(async () => ({})),
    fetchReply: vi.fn(async () => ({ id: "987654321987654321" })),
    options: { getSubcommand: vi.fn(() => "claims"), getString: vi.fn(() => null), getRole: vi.fn(() => null), getChannel: vi.fn(() => null), getUser: vi.fn(() => null) },
  };
  src.deferReply = vi.fn(async () => { src.deferred = true; });
  return src;
}

async function bang(name, src, rest = "") {
  return handlers.get(name)({ message: src, rest, cmd: `!${name}` });
}
async function interaction(name, src) {
  return slash.get(name).handler({ interaction: src });
}
function output(src) {
  return (src.editReply.mock.calls.at(-1) || src.reply.mock.calls.at(-1))?.[0]?.content;
}

beforeEach(async () => {
  vi.resetModules(); // Each test gets fresh per-process request/cache state.
  const mod = await import("../../contests/advent.js");
  __testables = mod.__testables;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-12-10T15:00:00Z"));
  handlers = new Map(); slash = new Map(); settings = { ...SETTINGS }; claims = new Map();
  mocks.getAdventSettings.mockImplementation(async () => ({ ...settings }));
  mocks.updateAdventSettings.mockImplementation(async ({ patch }) => { settings = { ...settings, ...patch }; });
  mocks.insertAdventClaim.mockImplementation(async (claim) => {
    const key = `${claim.guildId}:${claim.date}:${claim.userId}`;
    if (claims.has(key)) return false;
    claims.set(key, claim);
    return true;
  });
  mocks.getAdventClaims.mockResolvedValue([]);
  mocks.isAdminOrPrivileged.mockReturnValue(false);
  mocks.sendDm.mockResolvedValue({ ok: true });
  const register = vi.fn();
  register.expose = ({ name, handler }) => handlers.set(name, handler);
  register.slash = (def, handler) => slash.set(def.name, { def, handler });
  mod.registerAdvent(register);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("public Advent claims", () => {
  it("shares one daily claim between text and slash commands and links the public reply", async () => {
    const first = source();
    await interaction("claim", first);
    expect(first.deferReply).toHaveBeenCalledWith({});
    expect(output(first)).toContain("claimed for **2026-12-10**");
    expect(first.editReply.mock.calls[0][0].flags).toBeUndefined();
    expect(first.guild.members.fetch).toHaveBeenCalledWith({ user: "88888", force: true });
    expect(mocks.insertAdventClaim).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "987654321987654321" }));
    const second = source();
    await bang("claim", second);
    expect(output(second)).toContain("already claimed");
    expect(claims.size).toBe(1);
  });

  it("handles simultaneous claims without duplicate acceptance", async () => {
    const a = source(), b = source();
    await Promise.all([bang("claim", a), interaction("claim", b)]);
    expect(claims.size).toBe(1);
    expect([output(a), output(b)].filter((text) => text.includes("✅"))).toHaveLength(1);
  });

  it.each([
    ["2026-12-01T04:59:59Z", false],
    ["2026-12-01T05:00:00Z", true],
    ["2026-12-25T04:59:59Z", true],
    ["2026-12-25T05:00:00Z", false],
  ])("uses TPPC boundaries at %s", async (time, allowed) => {
    const src = source({ timestamp: Date.parse(time) });
    await bang("claim", src);
    expect(mocks.insertAdventClaim).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) expect(output(src)).toContain("December 1–24");
  });

  it("uses the invocation date when processing crosses midnight", async () => {
    vi.setSystemTime(new Date("2026-12-11T05:00:01Z"));
    const src = source({ timestamp: Date.parse("2026-12-11T04:59:59Z") });
    await bang("claim", src);
    expect(output(src)).toContain("2026-12-10");
  });

  it("permits another day, another year, and another guild independently", async () => {
    for (const [guildId, timestamp] of [
      ["12345", "2026-12-10T15:00:00Z"], ["12345", "2026-12-11T15:00:00Z"],
      ["12345", "2027-12-10T15:00:00Z"], ["54321", "2026-12-10T15:00:00Z"],
    ]) await bang("claim", source({ guildId, timestamp: Date.parse(timestamp) }));
    expect(claims.size).toBe(4);
  });

  it.each([ChannelType.PrivateThread, ChannelType.GuildText])("rejects nonpublic/nonthread channels (%s)", async (type) => {
    const src = source({ type });
    await interaction("claim", src);
    expect(output(src)).toContain("publicly");
    expect(src.deferReply).toHaveBeenCalledWith({});
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
  });

  it("rejects another thread and DM claims", async () => {
    const wrong = source({ channelId: "99999" });
    await bang("claim", wrong);
    expect(output(wrong)).toContain("<#66666>");
    const dm = source(); dm.guildId = null; dm.guild = null;
    await interaction("claim", dm);
    expect(output(dm)).toContain("publicly");
    expect(dm.deferReply).not.toHaveBeenCalled();
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
  });

  it("checks the current role without a staff or host eligibility bypass", async () => {
    mocks.isAdminOrPrivileged.mockReturnValue(true);
    const src = source({ userId: SETTINGS.hostId });
    src.guild.members.fetch.mockResolvedValue(member(SETTINGS.hostId, []));
    await interaction("claim", src);
    expect(output(src)).toContain("participant role");
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
    expect(src.editReply.mock.calls[0][0].flags).toBeUndefined();
  });

  it("fails gracefully on database or membership failures, without accepting a claim", async () => {
    mocks.getAdventSettings.mockRejectedValueOnce(new Error("DB offline"));
    const dbFail = source(); await bang("claim", dbFail);
    expect(output(dbFail)).toContain("try again");
    const fetchFail = source(); fetchFail.guild.members.fetch.mockRejectedValue(new Error("fetch failed"));
    await interaction("claim", fetchFail);
    expect(output(fetchFail)).toContain("try again");
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
  });

  it("does not backdate claims from text arguments", async () => {
    const src = source(); await bang("claim", src, "2026-12-09");
    expect(output(src)).toContain("without a date");
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
  });
});

describe("Advent reports and access", () => {
  it.each(["today", "yesterday", "2025-12-24"])("lets the nonprivileged host query %s", async (date) => {
    const src = source({ userId: SETTINGS.hostId });
    await bang("advent", src, `claims ${date}`);
    const expected = { today: "2026-12-10", yesterday: "2026-12-09" }[date] || date;
    expect(mocks.getAdventClaims).toHaveBeenCalledWith({ guildId: "12345", date: expected });
    expect(mocks.sendDm).toHaveBeenCalledWith(expect.objectContaining({ user: src.user }));
    expect(output(src)).toContain("0** claim(s)");
  });

  it("allows privileged reporters and defaults to yesterday", async () => {
    mocks.isAdminOrPrivileged.mockReturnValue(true);
    const src = source(); await interaction("advent", src);
    expect(mocks.getAdventClaims).toHaveBeenCalledWith({ guildId: "12345", date: "2026-12-09" });
  });

  it("keeps December 24 accessible after midnight December 25 and historical reports after the year ends", async () => {
    vi.setSystemTime(new Date("2026-12-25T05:00:01Z"));
    await bang("advent", source({ userId: SETTINGS.hostId }), "claims");
    expect(mocks.getAdventClaims).toHaveBeenLastCalledWith({ guildId: "12345", date: "2026-12-24" });
    vi.setSystemTime(new Date("2028-07-01T15:00:00Z"));
    await bang("advent", source({ userId: SETTINGS.hostId }), "claims 2026-12-24");
    expect(mocks.getAdventClaims).toHaveBeenLastCalledWith({ guildId: "12345", date: "2026-12-24" });
  });

  it("exports identity snapshots and dated claims without needing the current role", async () => {
    mocks.getAdventClaims.mockResolvedValue([{ user_id: "123456789012345678", username: "old_name", display_name: '=HYPERLINK("bad")', claimed_at_ms: Date.now(), channel_id: "66666", source_id: "99999" }]);
    const src = source({ userId: SETTINGS.hostId }); await bang("advent", src, "claims today");
    const payload = mocks.sendDm.mock.calls[0][0].payload;
    expect(payload.content).toContain("Total accepted claims: **1**");
    expect(payload.content).toContain("snapshot");
    const csv = payload.files[0].attachment.toString("utf8");
    expect(csv).toContain("old_name");
    expect(csv).toContain("'123456789012345678");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("https://discord.com/channels/12345/66666/99999");
    expect(src.guild.members.fetch).not.toHaveBeenCalled();
  });

  it.each(["2026-12-25", "2026-11-30", "2026-12-00", "2026-12-32", "12", "2026-12-10 2026-12-11"])("rejects invalid or batch date %s", async (date) => {
    await bang("advent", source({ userId: SETTINGS.hostId }), `claims ${date}`);
    expect(mocks.getAdventClaims).not.toHaveBeenCalled();
    expect(mocks.sendDm).not.toHaveBeenCalled();
  });

  it("denies nonstaff reports, settings changes, and role counts", async () => {
    for (const [name, rest] of [["advent", "claims today"], ["advent", "config host 88888"], ["rolecount", "55555"]]) {
      const src = source(); await bang(name, src, rest);
      expect(output(src)).toContain("Only privileged");
    }
    expect(mocks.getAdventClaims).not.toHaveBeenCalled();
    expect(mocks.updateAdventSettings).not.toHaveBeenCalled();
  });

  it("handles closed DMs without posting claimant details publicly", async () => {
    mocks.sendDm.mockResolvedValue({ ok: false });
    const src = source({ userId: SETTINGS.hostId }); await bang("advent", src, "claims today");
    expect(output(src)).toContain("Enable DMs");
    expect(src.reply.mock.calls[0][0].files).toBeUndefined();
  });

  it.each(["text", "slash"])("waits for a pre-midnight %s claim before exporting yesterday", async (commandType) => {
    vi.setSystemTime(new Date("2026-12-25T05:00:01Z"));
    const entered = deferred(), finish = deferred();
    const claimant = source({ timestamp: Date.parse("2026-12-25T04:59:59Z") });
    claimant.guild.members.fetch.mockImplementation(() => { entered.resolve(); return finish.promise; });
    mocks.getAdventClaims.mockImplementation(async () => [...claims.values()].map((c) => ({
      user_id: c.userId, username: c.username, display_name: c.displayName,
      claimed_at_ms: c.claimedAtMs, channel_id: c.channelId, source_id: c.sourceId,
    })));
    const claimTask = commandType === "slash" ? interaction("claim", claimant) : bang("claim", claimant);
    await entered.promise;
    const reporter = source({ userId: SETTINGS.hostId });
    const reportTask = bang("advent", reporter, "claims");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAdventClaims).not.toHaveBeenCalled();
    finish.resolve(member());
    await Promise.all([claimTask, reportTask]);
    expect(output(claimant)).toContain("claimed for **2026-12-24**");
    const payload = mocks.sendDm.mock.calls[0][0].payload;
    expect(payload.content).toContain("Total accepted claims: **1**");
    expect(payload.content).toContain("As of:");
    expect(payload.files[0].attachment.toString()).toContain("88888");
  });

  it("tracks slash claims before the public deferral finishes", async () => {
    vi.setSystemTime(new Date("2026-12-25T05:00:01Z"));
    const started = deferred(), finish = deferred();
    const claimant = source({ timestamp: Date.parse("2026-12-25T04:59:59Z") });
    claimant.deferReply.mockImplementation(async () => {
      started.resolve(); await finish.promise; claimant.deferred = true;
    });
    const claimTask = interaction("claim", claimant);
    await started.promise;
    const reportTask = bang("advent", source({ userId: SETTINGS.hostId }), "claims");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAdventClaims).not.toHaveBeenCalled();
    finish.resolve();
    await Promise.all([claimTask, reportTask]);
    expect(mocks.getAdventClaims).toHaveBeenCalled();
  });

  it("refuses to export if a closed day's claims exceed the wait, and allows a later retry", async () => {
    vi.setSystemTime(new Date("2026-12-25T05:00:01Z"));
    const started = deferred(), finish = deferred();
    const claimant = source({ timestamp: Date.parse("2026-12-25T04:59:59Z") });
    claimant.guild.members.fetch.mockImplementation(() => { started.resolve(); return finish.promise; });
    const claimTask = bang("claim", claimant);
    await started.promise;
    const reporter = source({ userId: SETTINGS.hostId });
    const reportTask = bang("advent", reporter, "claims");
    await vi.advanceTimersByTimeAsync(15_000);
    await reportTask;
    expect(output(reporter)).toContain("no report was sent");
    expect(mocks.getAdventClaims).not.toHaveBeenCalled();
    expect(mocks.sendDm).not.toHaveBeenCalled();
    finish.resolve(member()); await claimTask;
    await bang("advent", reporter, "claims");
    expect(mocks.sendDm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases failed claims so they do not block subsequent reports", async () => {
    vi.setSystemTime(new Date("2026-12-25T05:00:01Z"));
    const entered = deferred(), finish = deferred();
    const claimant = source({ timestamp: Date.parse("2026-12-25T04:59:59Z") });
    claimant.guild.members.fetch.mockImplementation(() => { entered.resolve(); return finish.promise; });
    const claimTask = bang("claim", claimant);
    await entered.promise;
    const reportTask = bang("advent", source({ userId: SETTINGS.hostId }), "claims");
    await vi.advanceTimersByTimeAsync(0);
    finish.reject(new Error("membership fetch failed"));
    await Promise.all([claimTask, reportTask]);
    expect(mocks.sendDm).toHaveBeenCalledTimes(1);
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not block today's snapshot or a different server's report on another claim", async () => {
    const entered = deferred(), finish = deferred();
    const claimant = source();
    claimant.guild.members.fetch.mockImplementation(() => { entered.resolve(); return finish.promise; });
    const claimTask = bang("claim", claimant);
    await entered.promise;
    const reporter = source({ userId: SETTINGS.hostId });
    await bang("advent", reporter, "claims today");
    expect(output(reporter)).toContain("Sent you");
    await bang("advent", source({ userId: SETTINGS.hostId, guildId: "54321" }), "claims yesterday");
    expect(mocks.sendDm).toHaveBeenCalledTimes(2);
    finish.resolve(member()); await claimTask;
  });
});

describe("per-server Advent settings", () => {
  it("lets the host update settings and revokes access when the host changes", async () => {
    const src = source({ userId: SETTINGS.hostId });
    await bang("advent", src, "config host <@99999>");
    expect(mocks.updateAdventSettings).toHaveBeenCalledWith(expect.objectContaining({ guildId: "12345", patch: { hostId: "99999" }, updatedBy: SETTINGS.hostId }));
    const oldHost = source({ userId: SETTINGS.hostId }); await bang("advent", oldHost, "claims today");
    expect(output(oldHost)).toContain("Only privileged");
    const newHost = source({ userId: "99999" }); await bang("advent", newHost, "claims today");
    expect(output(newHost)).toContain("Sent you");
  });

  it("lets privileged users bootstrap settings via slash", async () => {
    mocks.isAdminOrPrivileged.mockReturnValue(true);
    const src = source();
    src.options.getSubcommand.mockReturnValue("config");
    src.options.getRole.mockReturnValue({ id: "44444" });
    src.options.getChannel.mockReturnValue({ id: "66666" });
    src.options.getUser.mockReturnValue({ id: "77777" });
    await interaction("advent", src);
    expect(mocks.updateAdventSettings).toHaveBeenCalledWith(expect.objectContaining({ patch: { roleId: "44444", channelId: "66666", hostId: "77777" } }));
    expect(output(src)).toContain("Updated");
  });

  it.each(["config channel 99999", "config dates 1-31", "config role malformed"])("rejects invalid configuration %s", async (rest) => {
    const src = source({ userId: SETTINGS.hostId });
    src.guild.channels.fetch.mockResolvedValue({ type: ChannelType.PrivateThread, isThread: () => true });
    await bang("advent", src, rest);
    expect(mocks.updateAdventSettings).not.toHaveBeenCalled();
  });

  it("validates all slash settings before writing any field", async () => {
    const src = source({ userId: SETTINGS.hostId });
    src.options.getSubcommand.mockReturnValue("config");
    src.options.getRole.mockReturnValue({ id: "44444" });
    src.options.getChannel.mockReturnValue({ id: "99999" });
    src.guild.channels.fetch.mockResolvedValue(null);
    await interaction("advent", src);
    expect(output(src)).toContain("public thread");
    expect(mocks.updateAdventSettings).not.toHaveBeenCalled();
  });
});

describe("role counts", () => {
  it("counts the full fetched membership rather than cached role members", async () => {
    const src = source({ userId: SETTINGS.hostId });
    src.options.getString.mockReturnValue("55555");
    src.guild.members.fetch.mockResolvedValue(new Map([
      ["1", member("1")], ["2", member("2")], ["3", member("3", [])],
    ]));
    await interaction("rolecount", src);
    expect(src.guild.members.fetch).toHaveBeenCalledWith({ time: 30_000 });
    expect(output(src)).toContain("**2** member(s)");
  });

  it("reports zero accurately and never substitutes a partial count on fetch failure", async () => {
    const zero = source({ userId: SETTINGS.hostId }); zero.guild.members.fetch.mockResolvedValue(new Map());
    await bang("rolecount", zero, "<@&55555>"); expect(output(zero)).toContain("**0**");
    const fail = source({ userId: SETTINGS.hostId, guildId: "54321" }); fail.guild.members.fetch.mockRejectedValue(new Error("intent unavailable"));
    await bang("rolecount", fail, "55555"); expect(output(fail)).toContain("try again");
    expect(output(fail)).not.toContain("**0**");
  });

  it("reuses one immutable snapshot across consecutive roles until the 30-second expiry", async () => {
    const src = source({ userId: SETTINGS.hostId });
    const first = member("1", ["55555", "44444"]);
    const second = member("2", ["44444"]);
    src.guild.members.fetch.mockResolvedValueOnce(new Map([["1", first], ["2", second]]));
    await bang("rolecount", src, "55555");
    expect(output(src)).toContain("**1** member(s)");
    const originalTimestamp = output(src).match(/<t:\d+:F>/)[0];
    first.roles.cache.clear(); // Live cache changes must not mutate the snapshot.
    await vi.advanceTimersByTimeAsync(29_999);
    await bang("rolecount", src, "44444");
    expect(output(src)).toContain("**2** member(s)");
    expect(output(src)).toContain(originalTimestamp);
    expect(src.guild.members.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    src.guild.members.fetch.mockResolvedValueOnce(new Map());
    await bang("rolecount", src, "44444");
    expect(src.guild.members.fetch).toHaveBeenCalledTimes(2);
    expect(output(src)).toContain("**0** member(s)");
  });

  it("shares simultaneous full-member fetches and scopes cached counts per server", async () => {
    const started = deferred(), finish = deferred();
    const src = source({ userId: SETTINGS.hostId });
    src.guild.members.fetch.mockImplementation(() => { started.resolve(); return finish.promise; });
    const a = bang("rolecount", src, "55555");
    await started.promise;
    const b = bang("rolecount", src, "44444");
    await vi.advanceTimersByTimeAsync(0);
    expect(src.guild.members.fetch).toHaveBeenCalledTimes(1);
    finish.resolve(new Map([["1", member("1", ["55555", "44444"])]]));
    await Promise.all([a, b]);
    const other = source({ userId: SETTINGS.hostId, guildId: "54321" });
    other.guild.members.fetch.mockResolvedValue(new Map());
    await bang("rolecount", other, "55555");
    expect(other.guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(output(other)).toContain("**0** member(s)");
  });

  it("honors gateway retry_after without caching a failed result", async () => {
    const src = source({ userId: SETTINGS.hostId });
    src.guild.members.fetch.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { data: { retry_after: 45 } }));
    await bang("rolecount", src, "55555");
    expect(output(src)).toContain("**45** second(s)");
    await vi.advanceTimersByTimeAsync(30_000);
    await bang("rolecount", src, "55555");
    expect(output(src)).toContain("**15** second(s)");
    expect(src.guild.members.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    src.guild.members.fetch.mockResolvedValueOnce(new Map([["1", member("1")]]));
    await bang("rolecount", src, "55555");
    expect(output(src)).toContain("**1** member(s)");
    expect(src.guild.members.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("dev-only Advent test period", () => {
  function devSource(options) {
    const src = source(options);
    src.client = { user: { id: ADVENT_DEV_BOT_ID } };
    return src;
  }

  beforeEach(() => vi.stubEnv("ADVENT_DEV_CLAIM_PERIOD", "10-01..10-25"));

  it.each([
    ["2026-10-01T03:59:59Z", false], ["2026-10-01T04:00:00Z", true],
    ["2026-10-26T03:59:59Z", true], ["2026-10-26T04:00:00Z", false],
  ])("uses TPPC midnight boundaries for the override at %s", async (time, allowed) => {
    const src = devSource({ timestamp: Date.parse(time) });
    await bang("claim", src);
    expect(mocks.insertAdventClaim).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) expect(output(src)).toContain("October 1–25");
  });

  it("shares the October daily limit between text and slash claims and exports October reports", async () => {
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const first = devSource(); await bang("claim", first);
    expect(output(first)).toContain("claimed for **2026-10-17**");
    const second = devSource(); await interaction("claim", second);
    expect(output(second)).toContain("already claimed");
    expect(claims.size).toBe(1);
    await bang("advent", devSource({ userId: SETTINGS.hostId }), "claims today");
    expect(mocks.getAdventClaims).toHaveBeenCalledWith({ guildId: "12345", date: "2026-10-17" });
    await bang("advent", devSource({ userId: SETTINGS.hostId }), "claims 2025-12-24");
    expect(mocks.getAdventClaims).toHaveBeenLastCalledWith({ guildId: "12345", date: "2025-12-24" });
  });

  it("does not bypass membership and labels the configured test period", async () => {
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    const src = devSource(); src.guild.members.fetch.mockResolvedValue(member("88888", []));
    await bang("claim", src);
    expect(output(src)).toContain("participant role");
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
    const host = devSource({ userId: SETTINGS.hostId }); await bang("advent", host, "config");
    expect(output(host)).toContain("October 1–25");
    expect(output(host)).toContain("DEV TEST OVERRIDE");
  });

  it("keeps the production client on December despite a configured override", async () => {
    const src = source({ timestamp: Date.parse("2026-10-17T12:00:00Z") });
    src.client = { user: { id: "production-bot" } };
    await bang("claim", src);
    expect(output(src)).toContain("December 1–24");
    expect(mocks.insertAdventClaim).not.toHaveBeenCalled();
    vi.stubEnv("ADVENT_DEV_CLAIM_PERIOD", "invalid");
    const december = source(); december.client = src.client;
    await bang("claim", december);
    expect(output(december)).toContain("claimed for **2026-12-10**");
  });

  it("waits for dev-period claims before exporting a closed day", async () => {
    vi.setSystemTime(new Date("2026-10-26T04:00:01Z"));
    const started = deferred(), finish = deferred();
    const claimant = devSource({ timestamp: Date.parse("2026-10-26T03:59:59Z") });
    claimant.deferReply.mockImplementation(async () => { started.resolve(); await finish.promise; claimant.deferred = true; });
    const claimTask = interaction("claim", claimant);
    await started.promise;
    const reportTask = bang("advent", devSource({ userId: SETTINGS.hostId }), "claims");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.getAdventClaims).not.toHaveBeenCalled();
    finish.resolve(); await Promise.all([claimTask, reportTask]);
    expect(output(claimant)).toContain("claimed for **2026-10-25**");
    expect(mocks.getAdventClaims).toHaveBeenCalledWith({ guildId: "12345", date: "2026-10-25" });
  });
});

describe("Advent helpers", () => {
  it("validates exact ID and mention syntax", () => {
    for (const input of ["12345", "<@12345>", "<@!12345>", "<@&12345>", "<#12345>"]) expect(__testables.parseId(input)).toBe("12345");
    for (const input of ["<@12345", "12345>", "abc", "55555 66666"]) expect(__testables.parseId(input)).toBeNull();
  });
});
