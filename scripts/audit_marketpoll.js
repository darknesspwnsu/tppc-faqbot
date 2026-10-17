#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { buildAssetUniverse, isSeedableKnownAsset, normalizeAssetKey, parseSeedCsv, parseSeedRange } from '../tools/marketpoll_model.js';
import { analyzeMarketPolls, renderMarketPollAudit, toCsv } from '../tools/marketpoll_audit.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELP = `Usage: npm run marketpoll:audit -- [options]

  --env PATH          Load DB_* variables from this dotenv file (default: .env)
  --guild ID          Restrict polls/settings/scheduler to one Discord guild
  --since DATE        Polls started on/after YYYY-MM-DD or an ISO UTC timestamp
  --min-votes N       Audit turnout threshold (default: 5)
  --recent-days N     Compare this many recent days with the prior window (default: 30)
  --out DIRECTORY     Output directory (default: analysis/marketpoll/<UTC timestamp>)
  --input PATH        Reanalyze a saved snapshot.json without any DB connection
  --help              Show this help

Uses DB_HOST, DB_PORT (3306), DB_USER, DB_PASSWORD, DB_NAME.
Existing process environment values take precedence over dotenv values.
Optional DB_SSL_CA: path to a trusted CA certificate for verified TLS.
Database access uses SELECT/SHOW inside a read-only consistent transaction.
No bot startup, migrations, Discord calls, or DB writes are performed.
Outputs: report.md, audit.json, snapshot.json, assets.csv, matchups.csv, weekly.csv.
Snapshot contains poll/message/guild IDs and aggregates; no credentials or voter IDs.
--input preserves the original capture time and scope; --guild/--since/--env cannot be combined with it.
`;

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    env: { type: 'string' }, guild: { type: 'string' }, since: { type: 'string' },
    'min-votes': { type: 'string', default: '5' }, 'recent-days': { type: 'string', default: '30' },
    out: { type: 'string' }, input: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  for (const key of ['min-votes', 'recent-days']) {
    if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1) {
      throw new Error(`--${key} must be a positive integer`);
    }
  }
  if (values.guild && !/^\d+$/.test(values.guild)) throw new Error('--guild must be a numeric Discord guild ID');
  let sinceMs = null;
  if (values.since) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(values.since)) {
      throw new Error('--since must be YYYY-MM-DD or an ISO UTC timestamp ending in Z');
    }
    sinceMs = Date.parse(values.since);
    if (!Number.isFinite(sinceMs) || new Date(sinceMs).toISOString().slice(0, 10) !== values.since.slice(0, 10)) {
      throw new Error('--since is not a valid date');
    }
  }
  if (values.input && (values.guild || values.since || values.env)) {
    throw new Error('--input cannot be combined with --guild, --since, or --env; it preserves snapshot scope');
  }
  return { ...values, minVotes: Number(values['min-votes']), recentDays: Number(values['recent-days']), sinceMs };
}

async function readSeeds(overrides, warnings) {
  try {
    const [csv, genders, evolution] = await Promise.all([
      fs.readFile(path.join(ROOT, 'data/marketpoll_seeds.csv'), 'utf8'),
      fs.readFile(path.join(ROOT, 'data/golden_pokemon_genders.csv'), 'utf8'),
      fs.readFile(path.join(ROOT, 'data/pokemon_evolutions.json'), 'utf8'),
    ]);
    const universe = buildAssetUniverse({ goldenGenderCsv: genders, evolutionData: JSON.parse(evolution) });
    const parsed = parseSeedCsv(csv, { assetUniverse: universe });
    warnings.push(...parsed.errors.map(e => `Seed file: ${e}`));
    const seeds = new Map(parsed.rows.map(s => [s.assetKey, { assetKey: s.assetKey, tierId: s.tierId }]));
    for (const override of overrides) {
      const key = normalizeAssetKey(override.asset_key), range = parseSeedRange(override.seed_range);
      const known = universe.allAssetsByKey.get(key);
      if (!key || !range.ok || (known && !isSeedableKnownAsset(known)) || (!known && !Number(override.is_provisional))) {
        warnings.push(`Invalid current seed override: ${override.asset_key}`);
        continue;
      }
      seeds.set(key, { assetKey: key, tierId: range.tierId });
    }
    return [...seeds.values()];
  } catch {
    warnings.push('Local seed files could not be loaded. Seed coverage is unavailable; observed poll analysis still works.');
    return [];
  }
}

// Uses its own connection: importing db.js would risk bot configuration logging.
// No table creation/repair is attempted, including on older production schemas.
export async function captureSnapshot(connection, options, loadSeeds = readSeeds) {
  const query = async (sql, params = []) => (await connection.query({ sql, timeout: 30_000 }, params))[0];
  const warnings = [];
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const tables = new Set((await query('SHOW TABLES')).map(r => String(Object.values(r)[0])));
    if (!tables.has('goldmarket_poll_runs')) throw new Error('goldmarket_poll_runs is missing; no migrations were run');
    const cols = new Set((await query('SHOW COLUMNS FROM goldmarket_poll_runs')).map(r => r.Field));
    const required = ['id', 'guild_id', 'message_id', 'left_asset_key', 'right_asset_key', 'votes_left', 'votes_right', 'total_votes', 'result', 'affects_score', 'started_at_ms', 'ends_at_ms', 'closed_at_ms'];
    const missing = required.filter(col => !cols.has(col));
    if (missing.length) throw new Error(`Poll table is missing required columns: ${missing.join(', ')}; no migrations were run`);
    const optional = ['left_assets_json', 'right_assets_json', 'score_mode'];
    const selectCols = [...required, ...optional.filter(col => cols.has(col))];
    for (const col of optional.filter(c => !cols.has(c))) warnings.push(`Legacy schema: ${col} is absent; using primary asset keys / counted mode.`);
    const where = [], params = [];
    if (options.guild) { where.push('guild_id = ?'); params.push(options.guild); }
    if (options.sinceMs !== null && options.sinceMs !== undefined) { where.push('started_at_ms >= ?'); params.push(options.sinceMs); }
    const polls = [];
    let lastId = '0';
    for (;;) {
      const rows = await query(`SELECT ${selectCols.join(', ')} FROM goldmarket_poll_runs WHERE ${[...where, 'id > ?'].join(' AND ')} ORDER BY id ASC LIMIT 1000`, [...params, lastId]);
      polls.push(...rows);
      if (rows.length < 1000) break;
      lastId = String(rows.at(-1).id);
    }
    const optionalRows = async (name, sql, args = []) => {
      if (!tables.has(name)) { warnings.push(`${name} is absent; that context is unavailable.`); return []; }
      try { return await query(sql, args); }
      catch (error) {
        if (!['ER_BAD_FIELD_ERROR', 'ER_TABLEACCESS_DENIED_ERROR'].includes(error.code)) throw error;
        warnings.push(`${name} could not be read (${error.code}); that context is unavailable.`);
        return [];
      }
    };
    const settings = await optionalRows('goldmarket_settings',
      `SELECT guild_id, enabled, cadence_minutes, poll_minutes, min_votes FROM goldmarket_settings${options.guild ? ' WHERE guild_id = ?' : ''}`, options.guild ? [options.guild] : []);
    const scores = await optionalRows('goldmarket_scores', 'SELECT asset_key, elo, polls_count FROM goldmarket_scores');
    const overrides = await optionalRows('goldmarket_seed_overrides', 'SELECT asset_key, seed_range, is_provisional FROM goldmarket_seed_overrides');
    const schedulerWhere = [], schedulerParams = [];
    if (options.guild) { schedulerWhere.push('guild_id = ?'); schedulerParams.push(options.guild); }
    if (options.sinceMs != null) { schedulerWhere.push('run_at_ms >= ?'); schedulerParams.push(options.sinceMs); }
    const scheduler = await optionalRows('goldmarket_scheduler_log',
      `SELECT status, reason, COUNT(*) AS runs FROM goldmarket_scheduler_log${schedulerWhere.length ? ` WHERE ${schedulerWhere.join(' AND ')}` : ''} GROUP BY status, reason ORDER BY runs DESC, status, reason`, schedulerParams);
    const capturedAtMs = Date.now();
    await connection.rollback();
    const seeds = await loadSeeds(overrides, warnings);
    return { version: 1, capturedAtMs, scope: { guildId: options.guild || null, since: options.sinceMs != null ? new Date(options.sinceMs).toISOString() : null }, polls, settings, scores, seeds, scheduler, warnings };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  let snapshot;
  if (options.input) {
    snapshot = JSON.parse(await fs.readFile(path.resolve(options.input), 'utf8'));
    if (snapshot.version !== 1 || !Array.isArray(snapshot.polls)) throw new Error('Unsupported snapshot: expected version 1 and polls array');
  } else {
    const envResult = dotenv.config({ path: options.env || path.join(ROOT, '.env'), quiet: true });
    if (options.env && envResult.error) throw new Error('Could not read the requested --env file');
    if (['DB_HOST', 'DB_USER', 'DB_NAME'].some(key => !process.env[key])) {
      throw new Error('Set DB_HOST, DB_USER, DB_NAME and DB_PASSWORD through your environment or --env file');
    }
    const ssl = process.env.DB_SSL_CA ? { ca: await fs.readFile(process.env.DB_SSL_CA), rejectUnauthorized: true } : undefined;
    let connection;
    try {
      console.log('Reading MarketPoll tables in a read-only consistent transaction...');
      connection = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME,
        connectTimeout: 10_000, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true,
        ...(ssl ? { ssl } : {}),
      });
      snapshot = await captureSnapshot(connection, options);
    } finally { if (connection) await connection.end(); }
  }
  const audit = analyzeMarketPolls(snapshot, options);
  const directory = path.resolve(options.out || path.join(ROOT, 'analysis/marketpoll', new Date().toISOString().replaceAll(':', '-')));
  await fs.mkdir(directory, { recursive: true });
  const files = {
    'report.md': renderMarketPollAudit(audit),
    'audit.json': JSON.stringify(audit, null, 2) + '\n',
    'snapshot.json': JSON.stringify(snapshot, null, 2) + '\n',
    'assets.csv': toCsv(audit.assets, ['assetKey', 'tier', 'currentlySeeded', 'coverage', 'polls', 'soloPolls', 'bundlePolls', 'opponents', 'votesFor', 'votesAgainst', 'soloVoteSharePct', 'component', 'currentGlobalElo', 'lastPoll']),
    'matchups.csv': toCsv(audit.matchups, ['sideA', 'sideB', 'mode', 'polls', 'totalVotes', 'votesA', 'votesB', 'shareAPct', 'winsA', 'winsB', 'ties', 'guilds', 'repeatedPreference', 'closeContest', 'recentPolls', 'previousPolls', 'recentVotes', 'previousVotes', 'recentShareAPct', 'previousShareAPct', 'changePp', 'firstPoll', 'lastPoll']),
    'weekly.csv': toCsv(audit.weekly, ['week', 'polls', 'usable', 'votes', 'errors']),
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(directory, name), content, { flag: 'wx' });
  console.log(`${audit.summary.usablePolls}/${audit.summary.polls} usable polls; ${audit.summary.usableVotes} vote events.`);
  console.log(`Report: ${path.join(directory, 'report.md')}`);
  console.log(`Snapshot and detailed exports: ${directory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // Database errors can include hostnames/usernames/SQL; never dump them or the environment.
    const safeCodes = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_SEQUENCE_TIMEOUT']);
    const message = error.code === 'EEXIST' ? 'Output files already exist. Choose a new --out directory.' : error.code ? (safeCodes.has(error.code) ? `${error.code}: check database access and connection settings.` : `Operation failed (${error.code}); check connection settings, schema, and output permissions.`) : error.message;
    console.error(`MarketPoll audit failed: ${message}`);
    process.exitCode = 1;
  });
}
