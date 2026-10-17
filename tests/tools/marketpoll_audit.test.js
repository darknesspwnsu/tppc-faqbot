import { describe, expect, it } from 'vitest';
import { analyzeMarketPolls, renderMarketPollAudit, toCsv } from '../../tools/marketpoll_audit.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 86_400_000;
function poll(id, changes = {}) {
  return {
    id, guild_id: '123', message_id: String(id), left_asset_key: 'GoldenA|M', right_asset_key: 'GoldenB|F',
    left_assets_json: null, right_assets_json: null,
    votes_left: 8, votes_right: 2, total_votes: 10, result: 'left', affects_score: 1, score_mode: 'counted',
    started_at_ms: NOW - 2 * DAY, ends_at_ms: NOW - 2 * DAY + 900_000,
    closed_at_ms: NOW - 2 * DAY + 900_000, ...changes,
  };
}
const snapshot = (polls = [], changes = {}) => ({ version: 1, capturedAtMs: NOW, polls,
  seeds: ['GoldenA|M', 'GoldenB|F', 'GoldenC|M'].map(assetKey => ({ assetKey, tierId: '1-5kx' })), ...changes });

describe('MarketPoll audit', () => {
  it('partitions exclusions, separating the audit threshold from historical affects_score', () => {
    const a = analyzeMarketPolls(snapshot([
      poll(1), poll(2, { affects_score: 0 }),
      poll(3, { score_mode: 'exhibition', affects_score: 0 }),
      poll(4, { votes_left: 1, votes_right: 0, total_votes: 1 }),
      poll(5, { result: 'error', affects_score: 0 }),
      poll(6, { closed_at_ms: null, affects_score: 0 }),
      poll(7, { total_votes: 9 }), poll(8, { result: 'tie' }),
    ]));
    expect(a.summary.outcomes).toEqual({ usable: 2, exhibition: 1, low_turnout: 1, error: 1, open: 1, invalid: 2 });
    expect(a.summary.usableVotes).toBe(20);
    expect(a.summary.usableButNoScore).toBe(1);
    expect(a.summary.overdueOpen).toBe(1);
    expect(a.summary.scoreCountedButUnusable).toBe(3);
  });

  it('canonicalizes swapped sides and keeps bundles separate from solo statistics', () => {
    const a = analyzeMarketPolls(snapshot([
      poll(1), poll(2, { left_asset_key: 'GoldenB|F', right_asset_key: 'GoldenA|M', votes_left: 2, votes_right: 8, result: 'right' }),
      poll(3, { left_assets_json: '["GoldenA|M","GoldenC|M"]' }),
    ]));
    const solo = a.matchups.find(m => m.mode === '1v1');
    expect(solo).toMatchObject({ polls: 2, votesA: 16, votesB: 4, shareAPct: 80, winsA: 2 });
    expect(a.assets.find(x => x.assetKey === 'GoldenA|M')).toMatchObject({ polls: 3, soloPolls: 2, bundlePolls: 1, votesFor: 16, opponents: 1 });
    expect(a.assets.find(x => x.assetKey === 'GoldenC|M')).toMatchObject({ votesFor: 0, soloVoteSharePct: null, component: null });
  });

  it('rejects corrupt, overlapping, duplicate, negative, and future records', () => {
    const a = analyzeMarketPolls(snapshot([
      poll(1, { left_assets_json: 'bad json' }), poll(2, { left_assets_json: '["GoldenB|F"]' }),
      poll(3, { votes_left: -1, total_votes: 1, result: 'right' }),
      poll(4, { started_at_ms: NOW + DAY }), poll(5), poll(6, { message_id: '5' }),
    ]));
    expect(a.summary.usablePolls).toBe(0);
    expect(a.summary.issues.duplicate_message).toBe(2);
    expect(a.summary.issues.invalid_sides).toBe(2);
  });

  it('identifies disconnected solo groups and counts untested current seeds', () => {
    const a = analyzeMarketPolls(snapshot([
      poll(1), poll(2, { left_asset_key: 'GoldenD|M', right_asset_key: 'GoldenE|M' }),
    ]));
    expect(a.summary).toMatchObject({ soloComponents: 2, seededAssetsCovered: 2, observedAssets: 4, seedCoveragePct: 66.7 });
    expect(a.assets.find(x => x.assetKey === 'GoldenC|M').coverage).toBe('untested');
    expect(a.tiers).toEqual([{ tier: '1-5kx', seededAssets: 3, covered: 2, broaderSoloCoverage: 0 }]);
  });

  it('recomputes turnout eligibility when changing the audit threshold', () => {
    const data = snapshot([poll(1), poll(2, { votes_left: 4, votes_right: 1, total_votes: 5, affects_score: 0 })]);
    expect(analyzeMarketPolls(data).summary.usablePolls).toBe(2);
    expect(analyzeMarketPolls(data, { minVotes: 10 }).summary).toMatchObject({ usablePolls: 1, usableVotes: 10 });
  });

  it('requires repeated poll agreement instead of letting one large poll dominate findings', () => {
    const a = analyzeMarketPolls(snapshot([
      poll(1), poll(2), poll(3),
      ...[4, 5].map(id => poll(id, { left_asset_key: 'GoldenC|M', votes_left: 4, votes_right: 6, result: 'right' })),
      poll(6, { left_asset_key: 'GoldenC|M', votes_left: 100, votes_right: 0, total_votes: 100 }),
    ]));
    expect(a.matchups.find(m => m.sideA[0] === 'GoldenA|M').repeatedPreference).toBe(true);
    expect(a.matchups.find(m => m.sideA.includes('GoldenC|M') || m.sideB.includes('GoldenC|M')).repeatedPreference).toBe(false);
  });

  it('compares identical matchups in adjacent windows with correct boundary handling', () => {
    const old = { votes_left: 2, votes_right: 8, result: 'right', started_at_ms: NOW - 30 * DAY, ends_at_ms: NOW - 30 * DAY + 1, closed_at_ms: NOW - 30 * DAY + 1 };
    const a = analyzeMarketPolls(snapshot([poll(1, old), poll(2, { ...old, started_at_ms: NOW - 31 * DAY }), poll(3), poll(4)]));
    // Exactly 30 days ago is in the recent window, so previous lacks repeat evidence.
    expect(a.matchups[0]).toMatchObject({ recentPolls: 3, previousPolls: 1, changePp: null });
    const b = analyzeMarketPolls(snapshot([poll(1, { ...old, started_at_ms: NOW - 32 * DAY }), poll(2, { ...old, started_at_ms: NOW - 31 * DAY }), poll(3), poll(4)]));
    expect(b.matchups[0]).toMatchObject({ recentShareAPct: 80, previousShareAPct: 20, changePp: 60 });
  });

  it('renders an empty report without inventing coverage or findings', () => {
    const a = analyzeMarketPolls(snapshot([], { seeds: [] }));
    expect(a.summary.seedCoveragePct).toBeNull();
    expect(a.summary.firstPoll).toBeNull();
    expect(renderMarketPollAudit(a)).toContain('0 of 0 polls');
    expect(renderMarketPollAudit(a)).toContain('not a confidence interval');
    expect(renderMarketPollAudit(a)).not.toContain('NaN');
  });

  it('does not mistake repeated voters for unique participants and escapes CSV formulas', () => {
    const report = renderMarketPollAudit(analyzeMarketPolls(snapshot([poll(1)])));
    expect(report).toContain('not unique people');
    expect(toCsv([{ value: '=HYPERLINK("bad")', count: 2 }], ['value', 'count'])).toContain('"\'=HYPERLINK(""bad"")","2"');
  });
});
