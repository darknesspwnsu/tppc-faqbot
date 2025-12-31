import { describe, it, expect } from "vitest";

import { __testables } from "../../rpg/findmyid.js";

const { parseFindMyIdMatches } = __testables;

describe("rpg findmyid parsing", () => {
  it("extracts name/id pairs from the matches table", () => {
    const html = `
      <h3>Searching Trainer Names For "abaci"</h3>
      <table class="m">
        <thead><tr><th colspan="2">Trainer Matches</th></tr></thead>
        <tbody>
          <tr class="r0">
            <td class="center"><a href="profile.php?id=2594462">abacia</a> (Trainer ID: 2594462)</td>
            <td class="center"><a href="profile.php?id=3473840">Abacinate</a> (Trainer ID: 3473840)</td>
          </tr>
          <tr class="r1">
            <td class="center"><a href="profile.php?id=3486635">Abacination</a> (Trainer ID: 3486635)</td>
          </tr>
        </tbody>
      </table>
    `;
    expect(parseFindMyIdMatches(html)).toEqual([
      { name: "abacia", id: "2594462" },
      { name: "Abacinate", id: "3473840" },
      { name: "Abacination", id: "3486635" },
    ]);
  });

  it("returns empty array when no matches table exists", () => {
    expect(parseFindMyIdMatches("<div>No matches</div>")).toEqual([]);
  });
});
