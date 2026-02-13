import { describe, expect, it } from "vitest";

import {
  parseSeedRange,
  buildAssetUniverse,
  parseSeedCsv,
  selectCandidatePair,
  selectCandidateMatchup,
  canonicalPairKey,
  applyEloFromVotes,
  applyEloFromVotesBundles,
} from "../../tools/marketpoll_model.js";

describe("marketpoll_model", () => {
  it("parses seed ranges with mixed units and inherited units", () => {
    const a = parseSeedRange("950kx-1.3mx");
    expect(a.ok).toBe(true);
    expect(a.minX).toBe(950_000);
    expect(a.maxX).toBe(1_300_000);

    const b = parseSeedRange("1.2-1.6mx");
    expect(b.ok).toBe(true);
    expect(b.minX).toBe(1_200_000);
    expect(b.maxX).toBe(1_600_000);

    const c = parseSeedRange("  950 kx   -   1.3 mx  ");
    expect(c.ok).toBe(true);
    expect(c.minX).toBe(950_000);
    expect(c.maxX).toBe(1_300_000);
  });

  it("accepts no-unit values as raw x and accepts single values", () => {
    const rangeNoUnit = parseSeedRange("1200-1600");
    expect(rangeNoUnit.ok).toBe(true);
    expect(rangeNoUnit.minX).toBe(1200);
    expect(rangeNoUnit.maxX).toBe(1600);

    const single = parseSeedRange("1.5mx");
    expect(single.ok).toBe(true);
    expect(single.minX).toBe(1_500_000);
    expect(single.maxX).toBe(1_500_000);
  });

  it("builds base-only universe and rejects evolved assets in seed csv", () => {
    const goldenCsv = [
      "name,genders,male,female,genderless,ungendered,total",
      '"GoldenCacnea",M/F,0,0,0,0,0',
      '"GoldenCacturne",M/F,0,0,0,0,0',
    ].join("\n");

    const evolutionData = {
      base_by_name: {
        cacnea: "Cacnea",
        cacturne: "Cacnea",
      },
    };

    const universe = buildAssetUniverse({
      goldenGenderCsv: goldenCsv,
      evolutionData,
    });

    expect(universe.eligibleAssetsByKey.has("GoldenCacnea|M")).toBe(true);
    expect(universe.eligibleAssetsByKey.has("GoldenCacturne|M")).toBe(false);

    const seedCsv = [
      "asset_key,seed_range",
      "GoldenCacnea|M,900kx-1.1mx",
      "GoldenCacnea|F,",
      "GoldenCacturne|F,1.2mx-1.4mx",
    ].join("\n");

    const parsed = parseSeedCsv(seedCsv, { assetUniverse: universe });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("evolved asset not allowed");
  });

  it("selects eligible pairs and respects cooldown/open-pair constraints", () => {
    const assets = [
      {
        assetKey: "GoldenA|M",
        gender: "M",
        minX: 1_000_000,
        maxX: 1_400_000,
        tierIndex: 8,
      },
      {
        assetKey: "GoldenB|M",
        gender: "M",
        minX: 1_200_000,
        maxX: 1_500_000,
        tierIndex: 8,
      },
      {
        assetKey: "GoldenC|F",
        gender: "F",
        minX: 1_450_000,
        maxX: 1_900_000,
        tierIndex: 8,
      },
    ];

    const pick1 = selectCandidatePair({
      assets,
      cooldowns: new Map(),
      openPairKeys: new Set(),
      nowMs: 1000,
      rng: () => 0,
      preferSameGender: true,
    });

    expect(pick1).not.toBeNull();
    expect([pick1.left.assetKey, pick1.right.assetKey].sort()).toEqual(["GoldenA|M", "GoldenB|M"]);

    const blocked = new Map([[canonicalPairKey("GoldenA|M", "GoldenB|M"), 5000]]);
    const pick2 = selectCandidatePair({
      assets,
      cooldowns: blocked,
      openPairKeys: new Set([canonicalPairKey("GoldenA|M", "GoldenC|F")]),
      nowMs: 1000,
      rng: () => 0,
      preferSameGender: true,
    });

    // Only A-C (open) and A-B (cooldown) are blocked, leaving B-C.
    expect(pick2).not.toBeNull();
    expect([pick2.left.assetKey, pick2.right.assetKey].sort()).toEqual(["GoldenB|M", "GoldenC|F"]);
    expect(pick2.usedFallbackGender).toBe(true);
  });

  it("selects eligible 1v2/2v1 matchups when max side size is 2", () => {
    const assets = [
      { assetKey: "GoldenA|M", gender: "M", minX: 1_000_000, maxX: 1_200_000, midX: 1_100_000, tierIndex: 8 },
      { assetKey: "GoldenB|M", gender: "M", minX: 1_000_000, maxX: 1_200_000, midX: 1_100_000, tierIndex: 8 },
      { assetKey: "GoldenC|M", gender: "M", minX: 900_000, maxX: 1_100_000, midX: 1_000_000, tierIndex: 8 },
      { assetKey: "GoldenD|M", gender: "M", minX: 950_000, maxX: 1_150_000, midX: 1_050_000, tierIndex: 8 },
    ];

    const seq = [0.99, 0, 0, 0.99, 0.5, 0.25, 0.75, 0.1];
    let idx = 0;
    const rng = () => {
      const v = seq[idx % seq.length];
      idx += 1;
      return v;
    };

    const pick = selectCandidateMatchup({
      assets,
      cooldowns: new Map(),
      openPairKeys: new Set(),
      nowMs: 1000,
      maxSideSize: 2,
      sideSizeOptions: [1, 2],
      preferSameGender: true,
      rng,
    });

    expect(pick).not.toBeNull();
    expect(pick.left.assetKeys.length).toBeGreaterThanOrEqual(1);
    expect(pick.left.assetKeys.length).toBeLessThanOrEqual(2);
    expect(pick.right.assetKeys.length).toBeGreaterThanOrEqual(1);
    expect(pick.right.assetKeys.length).toBeLessThanOrEqual(2);
    expect(new Set([...pick.left.assetKeys, ...pick.right.assetKeys]).size).toBe(
      pick.left.assetKeys.length + pick.right.assetKeys.length
    );
    expect(typeof pick.pairKey).toBe("string");
  });

  it("respects configured matchup modes when selecting candidates", () => {
    const assets = [
      { assetKey: "GoldenA|M", gender: "M", minX: 1_000_000, maxX: 1_200_000, midX: 1_100_000, tierIndex: 8 },
      { assetKey: "GoldenB|M", gender: "M", minX: 1_000_000, maxX: 1_200_000, midX: 1_100_000, tierIndex: 8 },
      { assetKey: "GoldenC|M", gender: "M", minX: 950_000, maxX: 1_150_000, midX: 1_050_000, tierIndex: 8 },
      { assetKey: "GoldenD|M", gender: "M", minX: 900_000, maxX: 1_100_000, midX: 1_000_000, tierIndex: 8 },
    ];

    const oneVsOne = selectCandidateMatchup({
      assets,
      cooldowns: new Map(),
      openPairKeys: new Set(),
      nowMs: 1000,
      maxSideSize: 2,
      sideSizeOptions: [1, 2],
      matchupModes: ["1v1"],
      preferSameGender: true,
      rng: () => 0.2,
    });

    expect(oneVsOne).not.toBeNull();
    expect(oneVsOne.left.assetKeys).toHaveLength(1);
    expect(oneVsOne.right.assetKeys).toHaveLength(1);

    const twoVsTwo = selectCandidateMatchup({
      assets,
      cooldowns: new Map(),
      openPairKeys: new Set(),
      nowMs: 1000,
      maxSideSize: 2,
      sideSizeOptions: [1, 2],
      matchupModes: ["2v2"],
      preferSameGender: true,
      rng: () => 0.8,
    });

    expect(twoVsTwo).not.toBeNull();
    expect(twoVsTwo.left.assetKeys).toHaveLength(2);
    expect(twoVsTwo.right.assetKeys).toHaveLength(2);
  });

  it("applies elo only when vote floor is met", () => {
    const low = applyEloFromVotes({
      leftScore: 1500,
      rightScore: 1500,
      votesLeft: 2,
      votesRight: 1,
      minVotes: 5,
    });

    expect(low.affectsScore).toBe(false);
    expect(low.leftScore).toBe(1500);

    const high = applyEloFromVotes({
      leftScore: 1500,
      rightScore: 1500,
      votesLeft: 8,
      votesRight: 5,
      minVotes: 5,
    });

    expect(high.affectsScore).toBe(true);
    expect(high.leftScore).toBeGreaterThan(1500);
    expect(high.rightScore).toBeLessThan(1500);
  });

  it("applies bundle elo updates for multi-asset sides", () => {
    const result = applyEloFromVotesBundles({
      leftScores: [1500, 1520],
      rightScores: [1510],
      votesLeft: 12,
      votesRight: 5,
      minVotes: 5,
    });

    expect(result.affectsScore).toBe(true);
    expect(result.leftScores).toHaveLength(2);
    expect(result.rightScores).toHaveLength(1);
    expect(result.leftScores[0]).toBeGreaterThan(1500);
    expect(result.leftScores[1]).toBeGreaterThan(1520);
    expect(result.rightScores[0]).toBeLessThan(1510);
  });
});
