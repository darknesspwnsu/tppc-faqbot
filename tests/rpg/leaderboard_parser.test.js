import { describe, it, expect } from "vitest";
import { __testables } from "../../rpg/leaderboard.js";

const {
  parseSsAnne,
  parseSafariZone,
  parseSpeedTower,
  parseRoulette,
  parseTrainingChallenge,
  parseTrainerRanks,
  parsePokemonRanks,
  renderTopRows,
} = __testables;

describe("rpg leaderboard parsing", () => {
  it("parses speed tower rows", () => {
    const html = `
      <table>
        <tbody>
          <tr class="r0">
            <td>Today's #1</td>
            <td><a href="profile.php?id=3181487">the infinity stones</a></td><td>Team TPPC</td><td>45</td><td>00:40</td>
          </tr>
          <tr class="r1">
            <td>Today's #2</td>
            <td><a href="profile.php?id=3489027">Fried Shrimp</a></td><td>Team TPPC</td><td>46</td><td>01:16</td>
          </tr>
        </tbody>
      </table>
    `;
    const rows = parseSpeedTower(html);
    expect(rows.length).toBe(2);
    expect(rows[0].trainerId).toBe("3181487");
    expect(rows[0].floor).toBe("45");
  });

  it("parses SS Anne rows", () => {
    const html = `
      <table class="ranks">
        <tbody>
          <tr><th>Standing</th><th>Trainer Name</th><th>Faction</th><th>Wins</th></tr>
          <tr class="r0">
            <td class="Team TPPC">1</td>
            <td class="Team TPPC"><a href="profile.php?id=3181487">the infinity stones</a></td>
            <td class="Team TPPC">Team TPPC</td>
            <td class="Team TPPC">28</td>
          </tr>
        </tbody>
      </table>
    `;
    const rows = parseSsAnne(html);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      rank: "1",
      trainer: "the infinity stones",
      trainerId: "3181487",
      faction: "Team TPPC",
      wins: "28",
    });
  });

  it("parses safari zone rows", () => {
    const html = `
      <table class="ranks">
        <tbody>
          <tr><th>Standing</th><th>Trainer Name</th><th>Pok&eacute;mon</th><th>Points</th></tr>
          <tr class="r1"><td>1</td><td>Space  Cowboy</td><td>Sunkern</td><td>7,719,200</td></tr>
          <tr class="r0"><td>2</td><td>LucaBrasi3</td><td>Sunkern</td><td>7,534,184</td></tr>
        </tbody>
      </table>
    `;
    const rows = parseSafariZone(html);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      rank: "1",
      trainer: "Space Cowboy",
      pokemon: "Sunkern",
      points: "7,719,200",
    });
  });

  it("parses roulette daily and weekly tables", () => {
    const html = `
      <h3>Standings for December 30, 2025</h3>
      <table class="ranks">
        <tbody>
          <tr><th>Standing</th><th>Trainer Name</th><th>Faction</th><th>Wins</th></tr>
          <tr class="r0"><td class="Team TPPC">1</td><td class="Team TPPC"><a href="profile.php?id=3491889">blazinxd</td><td class="Team TPPC">Team TPPC</td><td class="Team TPPC">36</td></tr>
          <tr class="r1"><td class="Team Galactic">2</td><td class="Team Galactic"><a href="profile.php?id=3476908">zeyny</td><td class="Team Galactic">Team Galactic</td><td class="Team Galactic">34</td></tr>
        </tbody>
      </table>
      <h3>Standings for December 28, 2025 through January 03, 2026</h3>
      <table class="ranks">
        <tbody>
          <tr><th>Standing</th><th>Trainer Name</th><th>Faction</th><th>Battle Date</th><th>Wins</th></tr>
          <tr class="r0"><td>1</td><td><a href="profile.php?id=1475582">Kuroyukihime</td><td>Team TPPC</td><td>December 29, 2025</td><td>96</td></tr>
        </tbody>
      </table>
    `;
    const tables = parseRoulette(html);
    expect(tables.daily.length).toBe(2);
    expect(tables.daily[0].trainerId).toBe("3491889");
    expect(tables.weekly.length).toBe(1);
    expect(tables.weekly[0].battleDate).toBe("December 29, 2025");
  });

  it("parses training challenge rows", () => {
    const html = `
      <table class="ranks">
        <tbody>
          <tr><th>Rank</th><th>Trainer Name</th><th>Pok&eacute;mon</th><th>Level</th><th>Number</th></tr>
          <tr class="r1"><td>1</td><td><a href="profile.php?id=499999">xXMewtwoMaster1314Xx</a></td><td>Luxray</td><td>353</td><td><a href="battle.php?Battle=Trainer&Trainer=499999">499999</a></td></tr>
          <tr class="r0"><td>2</td><td><a href="profile.php?id=3398019">Anavel</a></td><td>Scyther</td><td>295</td><td><a href="battle.php?Battle=Trainer&Trainer=3398019">3398019</a></td></tr>
        </tbody>
      </table>
    `;
    const rows = parseTrainingChallenge(html);
    expect(rows.length).toBe(2);
    expect(rows[0].pokemon).toBe("Luxray");
    expect(rows[0].level).toBe("353");
  });

  it("renders top rows per challenge", () => {
    const lines = renderTopRows("tc", [
      { rank: "1", trainer: "A", pokemon: "Luxray", level: "100", number: "123" },
    ]);
    expect(lines[0]).toMatch(/Luxray/);
  });

  it("renders top rows for SS Anne", () => {
    const lines = renderTopRows("ssanne", [
      {
        rank: "1",
        trainer: "the infinity stones",
        trainerId: "3181487",
        faction: "Team TPPC",
        wins: "28",
      },
    ]);
    expect(lines[0]).toBe("#1 — the infinity stones (Team TPPC) • 28");
  });

  it("renders top rows for safari zone", () => {
    const lines = renderTopRows("safarizone", [
      { rank: "1", trainer: "Space Cowboy", pokemon: "Sunkern", points: "7,719,200" },
    ]);
    expect(lines[0]).toBe("#1 — Space Cowboy • Sunkern • 7,719,200 pts");
  });

  it("renders top rows for roulette without wins label", () => {
    const lines = renderTopRows("roulette", [
      { rank: "1", trainer: "blazinxd", faction: "Team TPPC", wins: "36" },
    ]);
    expect(lines[0]).toBe("#1 — blazinxd (Team TPPC) • 36");
  });

  it("renders top rows for speed tower without floor label", () => {
    const lines = renderTopRows("speedtower", [
      {
        rank: "Today's #1",
        trainer: "the infinity stones",
        faction: "Team TPPC",
        floor: "45",
        time: "00:40",
      },
    ]);
    expect(lines[0]).toBe("Today's #1 — the infinity stones (Team TPPC) • 45 • 00:40");
  });

  it("parses trainer ranks", () => {
    const html = `
      <table class="ranks">
        <tbody>
          <tr><th>Rank</th><th>Trainer Name</th><th>Faction</th><th>Level</th><th>Number</th></tr>
          <tr class="r1 TeamGalactic"><td>1</td><td><a href="profile.php?id=3476575">GratzMatt Gym</a></td><td>Team Galactic</td><td>22,207</td><td><a href="battle.php?Battle=Trainer&Trainer=3476575">3476575</a></td></tr>
        </tbody>
      </table>
    `;
    const rows = parseTrainerRanks(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rank: "1",
      trainer: "GratzMatt Gym",
      trainerId: "3476575",
      faction: "Team Galactic",
      level: "22,207",
      number: "3476575",
    });
  });

  it("renders top rows for trainer ranks", () => {
    const lines = renderTopRows("trainers", [
      {
        rank: "1",
        trainer: "GratzMatt Gym",
        trainerId: "3476575",
        faction: "Team Galactic",
        level: "22,207",
        number: "3476575",
      },
    ], 10);
    expect(lines[0]).toBe("#1 — GratzMatt Gym (Team Galactic) • Lv 22,207 • ID 3476575");
  });

  it("parses pokemon ranks", () => {
    const html = `
      <table class="ranks">
        <tbody>
          <tr><th>Rank</th><th>Trainer Name</th><th>Pok&eacute;mon</th><th>Level</th><th>Number</th></tr>
          <tr class="r1 Team TPPC"><td>889</td><td><a href="profile.php?id=85970">B O N E</a></td><td>GoldenCharmander</td><td>5,000</td><td><a href="battle.php?Battle=Trainer&Trainer=85970">85970</a></td></tr>
        </tbody>
      </table>
    `;
    const rows = parsePokemonRanks(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rank: "889",
      trainer: "B O N E",
      trainerId: "85970",
      pokemon: "GoldenCharmander",
      level: "5,000",
      number: "85970",
    });
  });
});
