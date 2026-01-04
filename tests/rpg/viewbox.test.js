import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getSavedId: vi.fn(),
  getUserText: vi.fn(),
}));

const findMyIdMocks = vi.hoisted(() => ({
  fetchFindMyIdMatches: vi.fn(),
}));

const rpgMocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

vi.mock("../../db.js", () => dbMocks);
vi.mock("../../rpg/findmyid.js", () => findMyIdMocks);
vi.mock("../../auth.js", () => authMocks);
vi.mock("../../rpg/rpg_client.js", () => ({
  RpgClient: class {
    fetchPage(...args) {
      return rpgMocks.fetchPage(...args);
    }
  },
}));

import { registerViewbox } from "../../rpg/viewbox.js";

function makeRegister() {
  const calls = [];
  const register = (name, handler, help, opts) => {
    calls.push({ name, handler, help, opts });
  };
  register.expose = (cfg) => calls.push(cfg);
  register.slash = (def, handler) => calls.push({ name: def.name, handler, def });
  register.component = (prefix, handler) => calls.push({ prefix, handler });
  register.calls = calls;
  return register;
}

function getSlashHandler(register, name) {
  return register.calls.find((c) => c.name === name && c.handler)?.handler;
}

function makeInteraction({
  id = "",
  rpgusername = "",
  filter = "all",
  user = null,
} = {}) {
  return {
    guildId: "g1",
    user: {
      id: "u1",
      send: vi.fn(async () => ({})),
    },
    member: { id: "u1" },
    options: {
      getString: (key) => {
        if (key === "id") return id || null;
        if (key === "rpgusername") return rpgusername || null;
        if (key === "filter") return filter || null;
        return null;
      },
      getUser: (key) => (key === "user" ? user : null),
    },
    reply: vi.fn(async () => ({})),
  };
}

function extractRowData(components) {
  const rows = components || [];
  return rows.flatMap((row) => row.toJSON().components);
}

describe("rpg viewbox slash", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    dbMocks.getSavedId.mockReset();
    dbMocks.getUserText.mockReset();
    findMyIdMocks.fetchFindMyIdMatches.mockReset();
    rpgMocks.fetchPage.mockReset();
    authMocks.isAdminOrPrivileged.mockReset();
    authMocks.isAdminOrPrivileged.mockReturnValue(true);
    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("prompts for ID selection when tagged user has multiple IDs", async () => {
    const register = makeRegister();
    registerViewbox(register);
    const handler = getSlashHandler(register, "viewbox");

    const interaction = makeInteraction({
      user: { id: "u2" },
    });

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: "alt", addedAt: 2 },
        ],
      })
    );

    await handler({ interaction });

    expect(rpgMocks.fetchPage).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls[0][0];
    expect(replyArg.content).toContain("<@u2>");
    const rowData = extractRowData(replyArg.components);
    const customIds = rowData.map((c) => c.custom_id);
    expect(customIds).toEqual([
      "viewbox_confirm:select:u1:111:all",
      "viewbox_confirm:select:u1:222:all",
    ]);
    const labels = rowData.map((c) => c.label);
    expect(labels).toEqual(["111 (main)", "222 (alt)"]);
  });

  it("defaults to self and fetches when one ID is saved", async () => {
    const register = makeRegister();
    registerViewbox(register);
    const handler = getSlashHandler(register, "viewbox");

    const interaction = makeInteraction();

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({ ids: [{ id: 123, label: null, addedAt: 1 }] })
    );
    rpgMocks.fetchPage.mockResolvedValueOnce(
      `<div class="Linfo"><strong>Trainer Name:</strong> Test User<br /></div>
      <ul id="allPoke"><li class="N ">Abra (Level: 5)</li></ul>`
    );

    await handler({ interaction });

    expect(rpgMocks.fetchPage).toHaveBeenCalledWith(
      "https://www.tppcrpg.net/profile.php?id=123&View=All"
    );
    expect(interaction.user.send).toHaveBeenCalledWith(
      expect.stringContaining(
        "Viewing box contents for <@u1> (RPG username: Test User | RPG ID: 123)"
      )
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ Sent your box results via DM." })
    );
  });

  it("uses rpgusername lookup flow with confirmation", async () => {
    const register = makeRegister();
    registerViewbox(register);
    const handler = getSlashHandler(register, "viewbox");

    const interaction = makeInteraction({ rpgusername: "Trainer" });

    findMyIdMocks.fetchFindMyIdMatches.mockResolvedValueOnce([
      { name: "Trainer", id: 999 },
    ]);

    await handler({ interaction });

    const replyArg = interaction.reply.mock.calls[0][0];
    expect(replyArg.content).toContain("Located ID 999");
    const rowData = extractRowData(replyArg.components);
    const customIds = rowData.map((c) => c.custom_id);
    expect(customIds).toEqual([
      "viewbox_confirm:continue:u1:999:all",
      "viewbox_confirm:cancel:u1:999:all",
    ]);
  });

  it("replies ephemerally when DMs are closed", async () => {
    const register = makeRegister();
    registerViewbox(register);
    const handler = getSlashHandler(register, "viewbox");

    const interaction = makeInteraction({ id: "123" });
    interaction.user.send.mockRejectedValueOnce({ code: 50007 });

    rpgMocks.fetchPage.mockResolvedValueOnce(
      `<ul id="allPoke"><li class="N ">Abra (Level: 5)</li></ul>`
    );

    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "❌ I couldn't DM you. Please enable DMs from server members and try again.",
      })
    );
  });
});
