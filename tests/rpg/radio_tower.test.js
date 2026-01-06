import { describe, expect, it } from "vitest";
import * as radioTower from "../../rpg/radio_tower.js";

describe("radio tower helpers", () => {
  it("extractInnerText strips HTML", () => {
    const text = radioTower.__testables.extractInnerText(
      "<html><body>Team Rocket <b>here</b></body></html>"
    );
    expect(text).toBe("Team Rocket here");
  });
});
