import { describe, expect, it, vi } from "vitest";
import * as radioTower from "../../rpg/radio_tower.js";

describe("radio tower scheduler", () => {
  it("runs an immediate startup check", () => {
    vi.useFakeTimers();
    radioTower.__testables.__resetScheduler();
    const client = { guilds: { cache: new Map() }, channels: { fetch: vi.fn() } };
    const spy = vi.fn().mockResolvedValue();
    radioTower.__testables.__setCheckHook(spy);

    radioTower.scheduleRadioTowerMonitor(client);

    expect(spy).toHaveBeenCalledWith(client, "startup");
    radioTower.__testables.__setCheckHook(null);
    vi.useRealTimers();
  });

  it("nextMidnightEt schedules the next midnight in ET", () => {
    vi.setSystemTime(new Date("2026-01-04T03:00:00Z")); // 22:00 ET (prev day)
    const next = radioTower.__testables.nextMidnightEt(new Date());
    expect(next.toISOString()).toBe("2026-01-04T05:00:00.000Z"); // 00:00 ET
  });

  it("nextMidnightEt rolls forward after midnight ET", () => {
    vi.setSystemTime(new Date("2026-01-04T06:00:00Z")); // 01:00 ET
    const next = radioTower.__testables.nextMidnightEt(new Date());
    expect(next.toISOString()).toBe("2026-01-05T05:00:00.000Z");
  });

  it("extractInnerText strips HTML", () => {
    const text = radioTower.__testables.extractInnerText(
      "<html><body>Team Rocket <b>here</b></body></html>"
    );
    expect(text).toBe("Team Rocket here");
  });
});
