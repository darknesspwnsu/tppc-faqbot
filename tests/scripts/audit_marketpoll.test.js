import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureSnapshot, main, parseOptions } from '../../scripts/audit_marketpoll.js';

const columns = ['id', 'guild_id', 'message_id', 'left_asset_key', 'right_asset_key', 'votes_left', 'votes_right', 'total_votes', 'result', 'affects_score', 'started_at_ms', 'ends_at_ms', 'closed_at_ms'];
function connection({ failPolls = false } = {}) {
  return {
    query: vi.fn(async ({ sql }, params) => {
      if (sql === 'SHOW TABLES') return [[{ table: 'goldmarket_poll_runs' }]];
      if (sql.startsWith('SHOW COLUMNS')) return [columns.map(Field => ({ Field }))];
      if (sql.startsWith('SELECT')) {
        if (failPolls) throw new Error('Query failed');
        return [[]];
      }
      return [[]];
    }),
    rollback: vi.fn(async () => {}),
  };
}

describe('audit_marketpoll CLI and database reads', () => {
  it('validates dates, IDs, positive thresholds, and offline scope', () => {
    expect(parseOptions(['--since', '2026-10-01', '--guild', '123'])).toMatchObject({ sinceMs: Date.parse('2026-10-01'), guild: '123', minVotes: 5 });
    for (const args of [ ['--since', '2026-02-30'], ['--since', 'yesterday'], ['--min-votes', '0'], ['--recent-days', '1.5'], ['--guild', "1 OR 1=1"], ['--input', 'snapshot.json', '--guild', '123'] ]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  it('uses a read-only snapshot with parameterized scope and handles legacy/missing context', async () => {
    const conn = connection();
    const result = await captureSnapshot(conn, parseOptions(['--guild', '123', '--since', '2026-10-01']), async () => []);
    const calls = conn.query.mock.calls;
    expect(calls[1][0].sql).toBe('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const select = calls.find(([q]) => q.sql.startsWith('SELECT'));
    expect(select[0].sql).toContain('guild_id = ? AND started_at_ms >= ? AND id > ?');
    expect(select[1]).toEqual(['123', Date.parse('2026-10-01'), '0']);
    expect(calls.every(([q]) => /^(SET TRANSACTION|START TRANSACTION|SELECT|SHOW)/.test(q.sql))).toBe(true);
    expect(result.warnings.some(w => w.includes('Legacy schema'))).toBe(true);
    expect(result.scope.guildId).toBe('123');
    expect(conn.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back after a failed read', async () => {
    const conn = connection({ failPolls: true });
    await expect(captureSnapshot(conn, parseOptions([]), async () => [])).rejects.toThrow('Query failed');
    expect(conn.rollback).toHaveBeenCalledTimes(1);
  });

  it('merges production seed overrides with local baseline seeds', async () => {
    const conn = connection(), original = conn.query.getMockImplementation();
    conn.query.mockImplementation(async (q, params) => {
      if (q.sql === 'SHOW TABLES') return [[{ table: 'goldmarket_poll_runs' }, { table: 'goldmarket_seed_overrides' }]];
      if (q.sql.includes('FROM goldmarket_seed_overrides')) return [[{ asset_key: 'GoldenRiolu|M', seed_range: '2mx-3mx', is_provisional: 0 }]];
      return original(q, params);
    });
    const result = await captureSnapshot(conn, parseOptions([]));
    expect(result.seeds.length).toBeGreaterThan(10);
    expect(result.seeds.find(s => s.assetKey === 'GoldenRiolu|M')).toEqual({ assetKey: 'GoldenRiolu|M', tierId: '2mx-3mx' });
    expect(result.warnings.filter(w => /Seed file|Invalid current seed override/.test(w))).toEqual([]);
  });

  it('paginates through the whole history using lossless large IDs', async () => {
    const conn = connection();
    const original = conn.query.getMockImplementation();
    let reads = 0;
    conn.query.mockImplementation(async (q, params) => {
      if (q.sql.startsWith('SELECT')) {
        reads++;
        if (reads === 1) return [Array.from({ length: 1000 }, (_, n) => ({ id: String(9007199254741000n + BigInt(n)) }))];
        expect(params.at(-1)).toBe('9007199254741999');
        return [[{ id: '9007199254742000' }]];
      }
      return original(q, params);
    });
    const result = await captureSnapshot(conn, parseOptions([]), async () => []);
    expect(result.polls).toHaveLength(1001);
  });

  it('runs offline end to end and refuses to overwrite an existing report', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marketpoll-audit-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const input = path.join(dir, 'input.json'), out = path.join(dir, 'out');
      const capturedAtMs = Date.parse('2026-10-16T00:00:00Z');
      const polls = [1, 2, 3].map(id => ({ id, guild_id: '123', message_id: String(id),
        left_asset_key: 'GoldenRiolu|M', right_asset_key: 'GoldenBeldum|G',
        votes_left: 8, votes_right: 2, total_votes: 10, result: 'left', affects_score: 1,
        score_mode: 'counted', started_at_ms: capturedAtMs - 86_400_000,
        ends_at_ms: capturedAtMs - 86_000_000, closed_at_ms: capturedAtMs - 86_000_000 }));
      await fs.writeFile(input, JSON.stringify({ version: 1, capturedAtMs, polls, seeds: [] }));
      await main(['--input', input, '--out', out]);
      expect((await fs.readdir(out)).sort()).toEqual(['assets.csv', 'audit.json', 'matchups.csv', 'report.md', 'snapshot.json', 'weekly.csv']);
      expect(await fs.readFile(path.join(out, 'report.md'), 'utf8')).toContain('3 of 3 polls');
      const audit = JSON.parse(await fs.readFile(path.join(out, 'audit.json'), 'utf8'));
      expect(audit.matchups[0]).toMatchObject({ repeatedPreference: true, polls: 3, totalVotes: 30 });
      await expect(main(['--input', input, '--out', out])).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { log.mockRestore(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
