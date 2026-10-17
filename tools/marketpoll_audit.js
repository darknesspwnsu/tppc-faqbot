// Offline analysis only. This module never connects to the bot or database.
const DAY = 86_400_000;
const sum = (rows, fn) => rows.reduce((n, row) => n + fn(row), 0);
const pct = (n, d) => d ? Number((100 * n / d).toFixed(1)) : null;
const iso = (ms) => ms ? new Date(ms).toISOString() : null;
const minOf = values => values.reduce((best, n) => Math.min(best, n), Infinity);
const maxOf = values => values.reduce((best, n) => Math.max(best, n), -Infinity);
const countBy = (rows, fn) => {
  const out = {};
  for (const row of rows) {
    const key = fn(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
};

function side(raw, fallback) {
  if (raw == null || raw === '') return fallback ? [String(fallback)] : [];
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== 'string' || !x.trim())) {
    throw new Error('Invalid side');
  }
  return value.map(x => x.trim()).sort();
}

export function normalizePoll(row, nowMs) {
  const issues = [];
  let left = [], right = [];
  try {
    left = side(row.left_assets_json, row.left_asset_key);
    right = side(row.right_assets_json, row.right_asset_key);
    if (!left.length || !right.length || left.length > 2 || right.length > 2 ||
        new Set([...left, ...right]).size !== left.length + right.length) issues.push('invalid_sides');
  } catch { issues.push('invalid_sides'); }
  const started = Number(row.started_at_ms);
  const ends = Number(row.ends_at_ms);
  const closed = row.closed_at_ms == null ? null : Number(row.closed_at_ms);
  if (![started, ends].every(n => Number.isSafeInteger(n) && n > 0) ||
      ends < started || started > nowMs ||
      (closed !== null && (!Number.isSafeInteger(closed) || closed < started || closed > nowMs))) {
    issues.push('invalid_timestamps');
  }
  const votesLeft = Number(row.votes_left), votesRight = Number(row.votes_right);
  const totalVotes = Number(row.total_votes);
  if (![votesLeft, votesRight, totalVotes].every(n => Number.isSafeInteger(n) && n >= 0) ||
      votesLeft + votesRight !== totalVotes) issues.push('invalid_votes');
  const mode = row.score_mode == null ? 'counted' : String(row.score_mode);
  if (!['counted', 'exhibition'].includes(mode)) issues.push('invalid_score_mode');
  const result = String(row.result);
  if (closed !== null && result !== 'error' &&
      result !== (votesLeft > votesRight ? 'left' : votesLeft < votesRight ? 'right' : 'tie')) {
    issues.push('result_mismatch');
  }
  return {
    id: String(row.id), guildId: String(row.guild_id), messageId: String(row.message_id),
    left, right, votesLeft, votesRight, totalVotes, started, ends, closed, mode, result,
    affectsScore: Number(row.affects_score) === 1, issues,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
}

function componentsFor(rows) {
  const graph = new Map();
  for (const row of rows.filter(r => r.left.length === 1 && r.right.length === 1)) {
    const [a, b] = [row.left[0], row.right[0]];
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b); graph.get(b).add(a);
  }
  const seen = new Set(), components = [];
  for (const key of [...graph.keys()].sort()) {
    if (seen.has(key)) continue;
    const stack = [key], assets = [];
    seen.add(key);
    while (stack.length) {
      const current = stack.pop(); assets.push(current);
      for (const next of graph.get(current)) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    components.push({ id: components.length + 1, assets: assets.sort() });
  }
  return components;
}

export function analyzeMarketPolls(snapshot, { minVotes = 5, recentDays = 30 } = {}) {
  if (!Number.isInteger(minVotes) || minVotes < 1 || !Number.isInteger(recentDays) || recentDays < 1) {
    throw new Error('minVotes and recentDays must be positive integers');
  }
  const nowMs = Number(snapshot.capturedAtMs);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('Invalid snapshot timestamp');
  const polls = snapshot.polls.map(row => normalizePoll(row, nowMs));
  const messageCounts = countBy(polls, r => r.messageId);
  for (const row of polls) {
    if (messageCounts[row.messageId] > 1) row.issues.push('duplicate_message');
    row.exclusion = row.closed === null ? 'open' : row.result === 'error' ? 'error' :
      row.issues.length ? 'invalid' : row.mode === 'exhibition' ? 'exhibition' :
      row.totalVotes < minVotes ? 'low_turnout' : 'usable';
  }
  const usable = polls.filter(r => r.exclusion === 'usable');
  const validCompleted = polls.filter(r => r.closed !== null && r.result !== 'error' && !r.issues.length);
  const components = componentsFor(usable);
  const componentByKey = new Map(components.flatMap(c => c.assets.map(key => [key, c.id])));
  const assetMap = new Map((snapshot.seeds || []).map(s => [s.assetKey, {
    assetKey: s.assetKey, tier: s.tierId, currentlySeeded: true,
    polls: 0, soloPolls: 0, bundlePolls: 0, votesFor: 0, votesAgainst: 0,
    lastPollAtMs: 0, opponents: new Set(),
  }]));
  const matchupMap = new Map();
  for (const row of usable) {
    for (const [mine, theirs, votesFor, votesAgainst] of [
      [row.left, row.right, row.votesLeft, row.votesRight],
      [row.right, row.left, row.votesRight, row.votesLeft],
    ]) {
      for (const key of mine) {
        if (!assetMap.has(key)) assetMap.set(key, {
          assetKey: key, tier: null, currentlySeeded: false, polls: 0, soloPolls: 0,
          bundlePolls: 0, votesFor: 0, votesAgainst: 0, lastPollAtMs: 0, opponents: new Set(),
        });
        const asset = assetMap.get(key);
        asset.polls++;
        if (mine.length === 1 && theirs.length === 1) {
          asset.soloPolls++; asset.votesFor += votesFor; asset.votesAgainst += votesAgainst;
          asset.opponents.add(theirs[0]);
        } else asset.bundlePolls++;
        asset.lastPollAtMs = Math.max(asset.lastPollAtMs, row.started);
      }
    }
    // Canonicalize the full sides, never credit a bundle's votes to an individual.
    const sides = [row.left, row.right].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const key = JSON.stringify(sides);
    if (!matchupMap.has(key)) matchupMap.set(key, { sideA: sides[0], sideB: sides[1], rows: [] });
    matchupMap.get(key).rows.push({
      ...row, votesA: JSON.stringify(row.left) === JSON.stringify(sides[0]) ? row.votesLeft : row.votesRight,
    });
  }
  const scores = new Map((snapshot.scores || []).map(s => [s.asset_key, s]));
  const assets = [...assetMap.values()].map(a => ({
    ...a, opponents: a.opponents.size, soloVoteSharePct: pct(a.votesFor, a.votesFor + a.votesAgainst),
    component: componentByKey.get(a.assetKey) || null, lastPoll: iso(a.lastPollAtMs),
    coverage: a.polls === 0 ? 'untested' : a.soloPolls >= 5 && a.opponents.size >= 3 ? 'broader solo coverage' : 'limited',
    currentGlobalElo: scores.has(a.assetKey) ? Number(scores.get(a.assetKey).elo) : null,
  })).sort((a, b) => b.polls - a.polls || a.assetKey.localeCompare(b.assetKey));
  const matchups = [...matchupMap.values()].map(m => {
    const totalVotes = sum(m.rows, r => r.totalVotes), votesA = sum(m.rows, r => r.votesA);
    const winsA = m.rows.filter(r => r.votesA > r.totalVotes / 2).length;
    const winsB = m.rows.filter(r => r.votesA < r.totalVotes / 2).length;
    const ties = m.rows.length - winsA - winsB;
    const recent = m.rows.filter(r => r.started >= nowMs - recentDays * DAY);
    const previous = m.rows.filter(r => r.started >= nowMs - 2 * recentDays * DAY && r.started < nowMs - recentDays * DAY);
    const recentVotes = sum(recent, r => r.totalVotes), previousVotes = sum(previous, r => r.totalVotes);
    const recentPct = pct(sum(recent, r => r.votesA), recentVotes);
    const previousPct = pct(sum(previous, r => r.votesA), previousVotes);
    const shareA = pct(votesA, totalVotes), rawShareA = 100 * votesA / totalVotes;
    const enough = m.rows.length >= 3 && totalVotes >= 30;
    return {
      sideA: m.sideA, sideB: m.sideB, mode: `${m.sideA.length}v${m.sideB.length}`,
      polls: m.rows.length, totalVotes, votesA, votesB: totalVotes - votesA, shareAPct: shareA,
      winsA, winsB, ties, guilds: new Set(m.rows.map(r => r.guildId)).size,
      firstPoll: iso(minOf(m.rows.map(r => r.started))), lastPoll: iso(maxOf(m.rows.map(r => r.started))),
      repeatedPreference: enough && Math.max(rawShareA, 100 - rawShareA) >= 60 &&
        (shareA > 50 ? winsA : winsB) / m.rows.length >= 0.75,
      closeContest: enough && Math.abs(rawShareA - 50) <= 10,
      recentPolls: recent.length, previousPolls: previous.length, recentVotes, previousVotes,
      recentShareAPct: recentPct, previousShareAPct: previousPct,
      changePp: recent.length >= 2 && previous.length >= 2 && recentVotes >= 10 && previousVotes >= 10 ?
        Number((recentPct - previousPct).toFixed(1)) : null,
    };
  }).sort((a, b) => b.polls - a.polls || b.totalVotes - a.totalVotes || JSON.stringify(a.sideA).localeCompare(JSON.stringify(b.sideA)));
  const weeks = new Map();
  for (const row of polls.filter(r => !r.issues.includes('invalid_timestamps'))) {
    const date = new Date(row.started);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const week = date.toISOString().slice(0, 10);
    if (!weeks.has(week)) weeks.set(week, { week, polls: 0, usable: 0, votes: 0, errors: 0 });
    const bucket = weeks.get(week); bucket.polls++;
    if (row.exclusion === 'usable') { bucket.usable++; bucket.votes += row.totalVotes; }
    if (row.exclusion === 'error') bucket.errors++;
  }
  const guilds = [...new Set(polls.map(r => r.guildId))].sort().map(guildId => {
    const rows = polls.filter(r => r.guildId === guildId);
    return { guildId, polls: rows.length, outcomes: countBy(rows, r => r.exclusion), usableVotes: sum(rows.filter(r => r.exclusion === 'usable'), r => r.totalVotes) };
  });
  const seededAssets = assets.filter(a => a.currentlySeeded);
  const tiers = [...new Set(seededAssets.map(a => a.tier))].map(tier => {
    const rows = seededAssets.filter(a => a.tier === tier);
    return { tier, seededAssets: rows.length, covered: rows.filter(a => a.polls > 0).length,
      broaderSoloCoverage: rows.filter(a => a.coverage === 'broader solo coverage').length };
  });
  const timestamps = polls.filter(r => !r.issues.includes('invalid_timestamps')).map(r => r.started);
  const summary = {
    polls: polls.length, outcomes: countBy(polls, r => r.exclusion), usablePolls: usable.length,
    usableVotes: sum(usable, r => r.totalVotes), usablePct: pct(usable.length, polls.length),
    medianVotesPerCompletedPoll: median(validCompleted.map(r => r.totalVotes)),
    zeroVoteCompletedPolls: validCompleted.filter(r => r.totalVotes === 0).length,
    turnout: countBy(validCompleted, r => r.totalVotes === 0 ? '0' : r.totalVotes < 5 ? '1–4' : r.totalVotes < 10 ? '5–9' : r.totalVotes < 20 ? '10–19' : '20+'),
    firstPoll: timestamps.length ? iso(minOf(timestamps)) : null,
    latestPoll: timestamps.length ? iso(maxOf(timestamps)) : null,
    daysSinceLatestPoll: timestamps.length ? Number(((nowMs - maxOf(timestamps)) / DAY).toFixed(1)) : null,
    overdueOpen: polls.filter(r => r.closed === null && r.ends <= nowMs).length,
    recordedScoreCounted: polls.filter(r => r.affectsScore).length,
    usableButNoScore: usable.filter(r => !r.affectsScore).length,
    scoreCountedButUnusable: polls.filter(r => r.affectsScore && r.exclusion !== 'usable').length,
    issues: countBy(polls.flatMap(r => r.issues), issue => issue),
    modes: countBy(usable, r => `${r.left.length}v${r.right.length}`),
    seededAssets: seededAssets.length, seededAssetsCovered: seededAssets.filter(a => a.polls > 0).length,
    seedCoveragePct: pct(seededAssets.filter(a => a.polls > 0).length, seededAssets.length),
    observedAssets: assets.filter(a => a.polls > 0).length,
    broaderSoloCoverageAssets: assets.filter(a => a.coverage === 'broader solo coverage').length,
    soloComponents: components.length, uniqueMatchups: matchups.length,
    repeatedMatchups: matchups.filter(m => m.polls >= 2).length,
  };
  return {
    generatedAt: iso(nowMs), scope: snapshot.scope || {}, options: { minVotes, recentDays },
    warnings: snapshot.warnings || [], summary, guilds, tiers, assets, matchups, components,
    weekly: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    scheduler: snapshot.scheduler || [], settings: snapshot.settings || [],
    excludedPolls: polls.filter(r => r.exclusion !== 'usable').map(r => ({ id: r.id, reason: r.exclusion, issues: r.issues })),
  };
}

const cell = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
function table(headers, rows) {
  if (!rows.length) return '_None._\n';
  return [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n') + '\n';
}
const sideLabel = side => side.join(' + ');

export function renderMarketPollAudit(audit) {
  const { summary: s, matchups, assets, options } = audit;
  const preferences = matchups.filter(m => m.repeatedPreference);
  const close = matchups.filter(m => m.closeContest);
  const changes = matchups.filter(m => m.changePp !== null).sort((a, b) => Math.abs(b.changePp) - Math.abs(a.changePp));
  const lines = [
    '# MarketPoll audit', '', `Snapshot: ${audit.generatedAt}. Scope: ${audit.scope.guildId || 'all guilds'}; since ${audit.scope.since || 'the beginning'}.`, '',
    '## What is usable?', '',
    `A usable poll is closed, non-error, structurally valid, counted (not exhibition), and has at least ${options.minVotes} votes. This audit threshold is independent of historical bot settings and affects_score. Each poll is classified once; issue counts can overlap.`, '',
    `**${s.usablePolls} of ${s.polls} polls (${s.usablePct ?? 0}%) are usable, containing ${s.usableVotes} vote events.** Median turnout across valid completed polls: ${s.medianVotesPerCompletedPoll ?? 'n/a'}. Zero-vote completed polls: ${s.zeroVoteCompletedPolls}.`, '',
    table(['Classification', 'Polls'], Object.entries(s.outcomes)),
    table(['Votes per valid completed poll (includes exhibitions)', 'Polls'], Object.entries(s.turnout)),
    `First poll: ${s.firstPoll || 'none'}. Latest: ${s.latestPoll || 'none'} (${s.daysSinceLatestPoll ?? 'n/a'} days ago). Overdue open polls: ${s.overdueOpen}.`, '',
    `Recorded as affecting Elo: ${s.recordedScoreCounted}. Usable but not scored: ${s.usableButNoScore}. Scored but excluded by this audit: ${s.scoreCountedButUnusable}. These differences can reflect changed thresholds; they are not automatically corruption.`, '',
    '## Coverage and comparability', '',
    `${s.seededAssetsCovered}/${s.seededAssets} currently seeded assets have usable results (${s.seedCoveragePct ?? 'n/a'}%). Total observed usable assets: ${s.observedAssets}. Assets with at least 5 solo polls against at least 3 opponents: ${s.broaderSoloCoverageAssets}.`, '',
    `${s.uniqueMatchups} distinct full matchups; ${s.repeatedMatchups} repeated. The usable 1v1 comparison graph has ${s.soloComponents} connected components. Assets in different components have no chain of observed solo comparisons; no overall ranking is inferred. Bundle-only and untested assets are outside this graph.`, '',
    table(['Usable matchup type', 'Polls'], Object.entries(s.modes)),
    table(['Current seed tier', 'Seeded assets', 'Covered', 'Broader solo coverage'], audit.tiers.map(t => [t.tier, t.seededAssets, t.covered, t.broaderSoloCoverage])),
    table(['Component', 'Assets', 'Examples'], audit.components.slice(0, 20).map(c => [c.id, c.assets.length, c.assets.slice(0, 4).join(', ')])),
    '## Repeated preferences', '',
    'Descriptive screening rule: at least 3 polls and 30 votes, at least 60% pooled support for one side, and that side wins at least 75% of polls. This is evidence of repeated preference, not a confidence interval or significance test.', '',
    table(['Preferred side', 'Other side', 'Support %', 'Poll wins / polls', 'Votes', 'Latest'], preferences.slice(0, 20).map(m => {
      const a = m.shareAPct > 50;
      return [sideLabel(a ? m.sideA : m.sideB), sideLabel(a ? m.sideB : m.sideA), a ? m.shareAPct : Number((100 - m.shareAPct).toFixed(1)), `${a ? m.winsA : m.winsB}/${m.polls}`, m.totalVotes, m.lastPoll.slice(0, 10)];
    })),
    '## Close contests worth polling again', '',
    'At least 3 polls and 30 votes with pooled support between 40% and 60%.', '',
    table(['Side A', 'Side B', 'A support %', 'Polls', 'Votes'], close.slice(0, 20).map(m => [sideLabel(m.sideA), sideLabel(m.sideB), m.shareAPct, m.polls, m.totalVotes])),
    '## Recent changes in the same matchup', '',
    `Latest ${options.recentDays} days versus the preceding ${options.recentDays} days, using poll start time. Requires at least 2 polls and 10 votes in each window. Positive change means more support for side A. Opponents and bundle composition stay identical; voter populations may change.`, '',
    table(['Side A', 'Side B', 'Previous A %', 'Recent A %', 'Change (pp)', 'Polls previous / recent'], changes.slice(0, 20).map(m => [sideLabel(m.sideA), sideLabel(m.sideB), m.previousShareAPct, m.recentShareAPct, m.changePp, `${m.previousPolls}/${m.recentPolls}`])),
    '## Assets to cover next', '',
    'Currently seeded assets with the fewest usable polls. Prioritize these and close contests; compare within appropriate value tiers and add bridge comparisons where appropriate.', '',
    table(['Asset', 'Current tier', 'Usable polls', 'Solo polls', 'Solo opponents'], [...assets].filter(a => a.currentlySeeded).sort((a, b) => a.polls - b.polls || a.assetKey.localeCompare(b.assetKey)).slice(0, 30).map(a => [a.assetKey, a.tier, a.polls, a.soloPolls, a.opponents])),
    '## Participation by UTC week', '',
    'Weeks begin Monday. Votes are from usable polls only. Weeks with no polls are omitted.', '',
    table(['Week', 'All polls', 'Usable', 'Usable votes', 'Errors'], audit.weekly.map(w => [w.week, w.polls, w.usable, w.votes, w.errors])),
    '## Guilds and scheduler', '',
    table(['Guild', 'Polls', 'Usable', 'Usable votes'], audit.guilds.map(g => [g.guildId, g.polls, g.outcomes.usable || 0, g.usableVotes])),
    table(['Guild', 'Enabled now', 'Cadence (minutes)', 'Duration (minutes)', 'Minimum votes now'], audit.settings.map(s => [s.guild_id, Number(s.enabled) === 1 ? 'yes' : 'no', s.cadence_minutes, s.poll_minutes, s.min_votes])),
    table(['Scheduler status', 'Reason', 'Runs'], audit.scheduler.map(r => [r.status, r.reason, r.runs])),
    '## Data quality', '',
    table(['Issue (may overlap)', 'Polls'], Object.entries(s.issues)),
    ...audit.warnings.map(w => `- ${w}`), '',
    '## Interpretation and limits', '',
    '- Vote totals are vote events, not unique people. Voter identities are not persisted, so repeat voters, coordinated voting, and independence cannot be assessed.',
    '- Polls measure stated trading preference, not completed trades or x prices. Matchmaking is biased toward manually seeded tiers and same-gender comparisons.',
    '- Bundle votes belong to the full bundle; individual vote shares use only 1v1 polls. Solo vote shares are not adjusted for opponent difficulty.',
    '- Current seeds, overrides, settings, and Elo are context at capture time, not historical snapshots. Coverage uses the current seed universe. Global Elo can include excluded polls and other guilds.',
    '- The bot increments W/L/T and polls_count even for low-turnout counted polls. Raw valid poll records are the source for this audit, rather than those score counters.',
    '- Combined guild results pool different communities. Use --guild to audit a community separately.',
    '- Screening thresholds describe sample coverage, not statistical certainty. Small samples and repeat voters limit conclusions.',
    '- Tables of findings show at most 20 rows; coverage priorities show 30. Full arrays are in audit.json and CSV files.', '',
  ];
  return lines.join('\n');
}

export function toCsv(rows, columns) {
  const escape = value => {
    let text = value == null ? '' : Array.isArray(value) ? value.join(' + ') : String(value);
    // Prevent spreadsheet formula execution when opening an export.
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns, ...rows.map(row => columns.map(key => row[key]))].map(row => row.map(escape).join(',')).join('\n') + '\n';
}
