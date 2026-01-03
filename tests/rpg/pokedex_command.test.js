import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const storageMocks = vi.hoisted(() => ({
  getPokedexEntry: vi.fn(),
  upsertPokedexEntry: vi.fn(),
}));

const rpgMocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
}));

vi.mock("../../rpg/storage.js", () => storageMocks);
vi.mock("../../rpg/rpg_client.js", () => ({
  RpgClient: class {
    fetchPage(...args) {
      return rpgMocks.fetchPage(...args);
    }
  },
}));

import { registerPokedex } from "../../rpg/pokedex.js";

function makeRegister() {
  const calls = [];
  const register = (name, handler) => calls.push({ name, handler });
  register.calls = calls;
  return register;
}

function getHandler(register, name) {
  return register.calls.find((c) => c.name === name)?.handler;
}

function makeMessage(rest) {
  return {
    guildId: "g1",
    reply: vi.fn(async () => ({})),
    rest,
  };
}

describe("rpg pokedex command", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    storageMocks.getPokedexEntry.mockReset();
    storageMocks.upsertPokedexEntry.mockReset();
    rpgMocks.fetchPage.mockReset();
    process.env = { ...envSnapshot };
    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("renders a pokedex entry with shiny sprite", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#681 - Aegislash (Blade)</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>60</td><td>140</td><td>50</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>60</td><td>140</td><td>50</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Steel</td><td>Ghost</td><td>Mineral</td><td></td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/681M-1.gif')\"><p>Normal &#9794;</p></div>",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/shiny/681M-1.gif')\"><p>Shiny &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Shiny Aegislash (Blade)" });

    expect(rpgMocks.fetchPage).toHaveBeenCalled();
    expect(storageMocks.upsertPokedexEntry).toHaveBeenCalledTimes(1);
    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.embeds[0].title).toContain("Aegislash");
    expect(replyArg.embeds[0].thumbnail.url).toContain("shiny/681M-1.gif");
  });

  it("refetches when cached payload is missing sprites", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce({
      entryKey: "pokedex:001-0",
      payload: { title: "Bulbasaur" },
      updatedAt: Date.now(),
    });

    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#001 - Bulbasaur</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>45</td><td>49</td><td>49</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>45</td><td>65</td><td>65</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Grass</td><td>Poison</td><td>Monster</td><td>Grass</td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/001M.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Bulbasaur" });

    expect(rpgMocks.fetchPage).toHaveBeenCalledTimes(1);
    expect(storageMocks.upsertPokedexEntry).toHaveBeenCalledTimes(1);
  });

  it("loads mega entries from pokedex map", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#006 - Charizard (Mega X)</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>78</td><td>130</td><td>111</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>100</td><td>130</td><td>85</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Fire</td><td>Dragon</td><td>Monster</td><td>Dragon</td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/006M-1.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Charizard (Mega X)" });

    expect(rpgMocks.fetchPage).toHaveBeenCalledWith(
      "https://www.tppcrpg.net/pokedex_entry.php?id=6&t=1"
    );
    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.embeds[0].title).toContain("Charizard");
  });
});
