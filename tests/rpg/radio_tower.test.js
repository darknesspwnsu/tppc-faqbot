import { describe, expect, it } from "vitest";
import * as radioTower from "../../rpg/radio_tower.js";

describe("radio tower helpers", () => {
  it("extractInnerText strips HTML", () => {
    const text = radioTower.__testables.extractInnerText(
      "<html><body>Team Rocket <b>here</b></body></html>"
    );
    expect(text).toBe("Team Rocket here");
  });

  it("matches on relaxed rocket keyword", () => {
    expect(radioTower.__testables.isRadioTowerHit("Team Rocket takeover")).toBe(true);
    expect(radioTower.__testables.isRadioTowerHit("Rocket activity reported")).toBe(true);
    expect(radioTower.__testables.isRadioTowerHit("No event active")).toBe(false);
  });
});
