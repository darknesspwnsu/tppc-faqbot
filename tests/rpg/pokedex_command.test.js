import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fsSync from "node:fs";

const storageMocks = vi.hoisted(() => ({
  getPokedexEntry: vi.fn(),
  upsertPokedexEntry: vi.fn(),
}));

const rpgMocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
}));

const evolutionMock = {
  pokemon_name: {
    0: "Charmander",
    1: "Charmeleon",
    2: "Charizard",
    3: "Bulbasaur",
    4: "Ralts",
    5: "Kirlia",
    6: "Gallade",
    7: "Krabby",
  },
  form: {
    0: "Normal",
    1: "Normal",
    2: "Normal",
    3: "Normal",
    4: "Normal",
    5: "Normal",
    6: "Normal",
    7: "Normal",
  },
  evolutions: {
    0: [{ pokemon_name: "Charmeleon", form: "Normal", pokemon_id: 5 }],
    1: [{ pokemon_name: "Charizard", form: "Normal", pokemon_id: 6 }],
    4: [{ pokemon_name: "Kirlia", form: "Normal", pokemon_id: 281 }],
    5: [{ pokemon_name: "Gallade", form: "Normal", pokemon_id: 475 }],
    7: [{ pokemon_name: "Kingler", form: "Normal", pokemon_id: 99 }],
  },
};
vi.mock("../../rpg/storage.js", () => storageMocks);
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (filePath) => {
      const path = String(filePath || "");
      if (path.endsWith("data/pokemon_evolutions.json")) {
        return JSON.stringify({
          base_by_name: {
            gallade: "Ralts",
            ralts: "Ralts",
            kingler: "Krabby",
            krabby: "Krabby",
          },
        });
      }
      if (path.endsWith("data/pokedex_map.json")) {
        return fsSync.readFileSync(path, "utf8");
      }
      return "";
    }),
  },
}));
vi.mock("../../rpg/rpg_client.js", () => ({
  RpgClient: class {
    fetchPage(...args) {
      return rpgMocks.fetchPage(...args);
    }
  },
}));

import { registerPokedex, handlePokedexInteraction } from "../../rpg/pokedex.js";
import { ButtonBuilder, ButtonStyle } from "discord.js";

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
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => evolutionMock,
    }));
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
    const hpField = replyArg.embeds[0].fields.find((f) => f.name === "HP");
    expect(hpField.value).toContain("(+5)");
  });

  it("renders golden stat bonuses", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
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
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/golden/001M.gif')\"><p>Golden &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Golden Bulbasaur" });

    const replyArg = message.reply.mock.calls[0][0];
    const hpField = replyArg.embeds[0].fields.find((f) => f.name === "HP");
    expect(hpField.value).toContain("(+15)");
  });

  it("returns the sprite url for the requested variant", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

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

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("https://graphics.tppcrpg.net/xy/shiny/681M-1.gif");
  });

  it("applies sprite library and gender options in any order", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#181 - Ampharos</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>90</td><td>75</td><td>85</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>55</td><td>115</td><td>90</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Electric</td><td></td><td>Monster</td><td>Field</td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/181M-1.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Ampharos hgss F" });

    let replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("https://graphics.tppcrpg.net/hgss/normal/181F-1.gif");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#181 - Ampharos</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>90</td><td>75</td><td>85</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>55</td><td>115</td><td>90</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Electric</td><td></td><td>Monster</td><td>Field</td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/181M-1.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message2 = makeMessage();
    await handler({ message: message2, rest: "Ampharos F blackwhite" });

    replyArg = message2.reply.mock.calls[0][0];
    expect(replyArg).toContain("https://graphics.tppcrpg.net/blackwhite/normal/181F-1.gif");
  });

  it("keeps supported form modifiers for hgss/bw sprites", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#479 - Rotom (Heat)</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>50</td><td>65</td><td>107</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Electric</td><td>Fire</td><td>Amorphous</td><td></td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/479M-1.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Rotom (Heat) hgss" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("https://graphics.tppcrpg.net/hgss/normal/479M-1.gif");
    expect(replyArg).not.toContain("does not support forms");
  });

  it("rejects sprite libraries that do not cover the requested dex id", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

    const message = makeMessage();
    await handler({ message, rest: "Grookey hgss" });

    expect(message.reply).toHaveBeenCalledWith("❌ The hgss sprite library only covers up to #493.");
    expect(rpgMocks.fetchPage).not.toHaveBeenCalled();
  });

  it("drops mega form suffix for hgss/bw sprites", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#181 - Ampharos (Mega)</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>90</td><td>75</td><td>85</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>55</td><td>115</td><td>90</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Electric</td><td></td><td>Monster</td><td>Field</td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/181M-1.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Ampharos (Mega) hgss" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("https://graphics.tppcrpg.net/hgss/normal/181M.gif");
  });

  it("adds a footnote when forms are stripped for older sprite libraries", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      [
        "<h3>#181 - Ampharos (Mega)</h3>",
        "<table class=\"dex\">",
        "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
        "<tr><td>90</td><td>75</td><td>85</td></tr>",
        "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
        "<tr><td>55</td><td>115</td><td>90</td></tr>",
        "</table>",
        "<table>",
        "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
        "<tr><td>Electric</td><td></td><td>Monster</td><td>Field</td></tr>",
        "</table>",
        "<td class=\"w50 iBox\">",
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/181M-1.gif')\"><p>Normal &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Ampharos (Mega) bw" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("https://graphics.tppcrpg.net/blackwhite/normal/181M.gif");
    expect(replyArg).toContain(
      "_(this sprite library does not support forms, falling back to displaying original sprite.)_"
    );
  });

  it("renders dark stat bonuses", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
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
        "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/dark/001M.gif')\"><p>Dark &#9794;</p></div>",
        "</td>",
      ].join("")
    );

    const message = makeMessage();
    await handler({ message, rest: "Dark Bulbasaur" });

    const replyArg = message.reply.mock.calls[0][0];
    const hpField = replyArg.embeds[0].fields.find((f) => f.name === "HP");
    expect(hpField.value).toContain("(+15/-4)");
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
  it("calculates egg time from base evolution stats", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage
      .mockResolvedValueOnce(
        [
          "<h3>#475 - Gallade</h3>",
          "<table class=\"dex\">",
          "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
          "<tr><td>68</td><td>125</td><td>65</td></tr>",
          "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
          "<tr><td>80</td><td>65</td><td>115</td></tr>",
          "</table>",
          "<table>",
          "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
          "<tr><td>Psychic</td><td>Fighting</td><td>Human-Like</td><td></td></tr>",
          "</table>",
          "<td class=\"w50 iBox\">",
          "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/475M.gif')\"><p>Normal &#9794;</p></div>",
          "</td>",
        ].join("")
      )
      .mockResolvedValueOnce(
        [
          "<h3>#280 - Ralts</h3>",
          "<table class=\"dex\">",
          "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
          "<tr><td>28</td><td>25</td><td>25</td></tr>",
          "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
          "<tr><td>40</td><td>45</td><td>35</td></tr>",
          "</table>",
          "<table>",
          "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
          "<tr><td>Psychic</td><td>Fairy</td><td>Amorphous</td><td></td></tr>",
          "</table>",
          "<td class=\"w50 iBox\">",
          "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/280M.gif')\"><p>Normal &#9794;</p></div>",
          "</td>",
        ].join("")
      );

    const message = makeMessage();
    await handler({ message, rest: "Gallade" });

    const replyArg = message.reply.mock.calls[0][0];
    const eggField = replyArg.embeds[0].fields.find((f) => f.name.startsWith("Egg Time"));
    expect(eggField.value).toContain("01:39:00 (normal)");
    expect(eggField.value).toContain("00:49:30 (Power Plant)");
  });

  it("uses base evolution when evolution data lacks the target", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage
      .mockResolvedValueOnce(
        [
          "<h3>#099 - Kingler</h3>",
          "<table class=\"dex\">",
          "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
          "<tr><td>55</td><td>130</td><td>115</td></tr>",
          "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
          "<tr><td>75</td><td>50</td><td>50</td></tr>",
          "</table>",
          "<table>",
          "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
          "<tr><td>Water</td><td></td><td>Water 3</td><td></td></tr>",
          "</table>",
          "<td class=\"w50 iBox\">",
          "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/099M.gif')\"><p>Normal &#9794;</p></div>",
          "</td>",
        ].join("")
      )
      .mockResolvedValueOnce(
        [
          "<h3>#098 - Krabby</h3>",
          "<table class=\"dex\">",
          "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
          "<tr><td>30</td><td>105</td><td>90</td></tr>",
          "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
          "<tr><td>50</td><td>25</td><td>25</td></tr>",
          "</table>",
          "<table>",
          "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
          "<tr><td>Water</td><td></td><td>Water 3</td><td></td></tr>",
          "</table>",
          "<td class=\"w50 iBox\">",
          "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/098M.gif')\"><p>Normal &#9794;</p></div>",
          "</td>",
        ].join("")
      );

    const message = makeMessage();
    await handler({ message, rest: "Kingler" });

    const replyArg = message.reply.mock.calls[0][0];
    const eggField = replyArg.embeds[0].fields.find((f) => f.name.startsWith("Egg Time"));
    expect(eggField.value).toContain("02:42:30 (normal)");
    expect(eggField.value).toContain("01:21:00 (Power Plant)");
  });

  it("offers did you mean buttons with variant labels", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!pokedex");

    const message = makeMessage();
    await handler({ message, rest: "d.bulbasor" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.content).toContain("Did you mean");
    const row = replyArg.components[0];
    const button = row.components[0];
    const label = button.data?.label ?? button.label;
    const customId = button.data?.custom_id ?? button.customId;
    expect(label).toBe("DarkBulbasaur");
    expect(customId).toContain("pokedex_retry:!pokedex:DarkBulbasaur");
  });

  it("returns stats as text with modifiers", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!stats");

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

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("Aegislash");
    expect(replyArg).toContain("HP:");
    expect(replyArg).toContain("(+5)");
    expect(replyArg).toContain("Total: 500");
  });

  it("suggests non-variant names when variant is implicit", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!eggtime");

    const message = makeMessage();
    await handler({ message, rest: "galllade" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.content).toContain("Did you mean");
    const row = replyArg.components[0];
    const button = row.components[0];
    const label = button.data?.label ?? button.label;
    expect(label).toBe("Gallade");
  });

  it("keeps sprite options in did you mean suggestions", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!sprite");

    const message = makeMessage();
    await handler({ message, rest: "ampharis (mega) bw F" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg.content).toContain("Did you mean");
    const row = replyArg.components[0];
    const button = row.components[0];
    const label = button.data?.label ?? button.label;
    const customId = button.data?.custom_id ?? button.customId;
    expect(label).toBe("Ampharos bw F");
    expect(customId).toContain("pokedex_retry:!sprite:Ampharos%20bw%20F");
  });

  it("returns egg time as plain text", async () => {
    const register = makeRegister();
    registerPokedex(register);
    const handler = getHandler(register, "!eggtime");

    storageMocks.getPokedexEntry.mockResolvedValueOnce(null);
    rpgMocks.fetchPage
      .mockResolvedValueOnce(
        [
          "<h3>#475 - Gallade</h3>",
          "<table class=\"dex\">",
          "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
          "<tr><td>68</td><td>125</td><td>65</td></tr>",
          "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
          "<tr><td>80</td><td>65</td><td>115</td></tr>",
          "</table>",
          "<table>",
          "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
          "<tr><td>Psychic</td><td>Fighting</td><td>Human-Like</td><td></td></tr>",
          "</table>",
          "<td class=\"w50 iBox\">",
          "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/475M.gif')\"><p>Normal &#9794;</p></div>",
          "</td>",
        ].join("")
      )
      .mockResolvedValueOnce(
        [
          "<h3>#280 - Ralts</h3>",
          "<table class=\"dex\">",
          "<tr><th>HP</th><th>Attack</th><th>Defense</th></tr>",
          "<tr><td>28</td><td>25</td><td>25</td></tr>",
          "<tr><th>Speed</th><th>Spec Attack</th><th>Spec Defense</th></tr>",
          "<tr><td>40</td><td>45</td><td>35</td></tr>",
          "</table>",
          "<table>",
          "<tr><th>Type 1</th><th>Type 2</th><th>Group 1</th><th>Group 2</th></tr>",
          "<tr><td>Psychic</td><td>Fairy</td><td>Amorphous</td><td></td></tr>",
          "</table>",
          "<td class=\"w50 iBox\">",
          "<div style=\"background-image:url('//graphics.tppcrpg.net/xy/normal/280M.gif')\"><p>Normal &#9794;</p></div>",
          "</td>",
        ].join("")
      );

    const message = makeMessage();
    await handler({ message, rest: "Gallade" });

    const replyArg = message.reply.mock.calls[0][0];
    expect(replyArg).toContain("Breeding times for **Gallade** (Base evolution: **Ralts**)");
    expect(replyArg).toContain("01:39:00 (normal)");
    expect(replyArg).toContain("00:49:30 (Power Plant)");
  });
});

describe("rpg pokedex interaction", () => {
  it("handles retry buttons and disables them", async () => {
    const row = {
      type: 1,
      components: [
        new ButtonBuilder()
      .setCustomId("pokedex_retry:!pokedex:DarkBulbasaur")
      .setLabel("DarkBulbasaur")
      .setStyle(ButtonStyle.Secondary)
      .toJSON(),
      ],
    };
    const interaction = {
      customId: "pokedex_retry:!pokedex:DarkBulbasaur",
      message: { components: [row] },
      isButton: () => true,
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
    };

    const result = await handlePokedexInteraction(interaction);

    expect(result).toEqual({ cmd: "!pokedex", rest: "DarkBulbasaur" });
    expect(interaction.update).toHaveBeenCalledTimes(1);
    const updated = interaction.update.mock.calls[0][0];
    const updatedRow = updated.components[0].toJSON();
    expect(updatedRow.components[0].disabled).toBe(true);
  });
});
