import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuota, gearFor, planFor, describe as describeQuota, short, DEFAULT_THRESHOLDS, parseClaudeResetTime, parseClaudeUsageOutput } from '../quota';

function cacheWith(fiveUsed: number, weekUsed: number, fetchedAt = Date.now()): string {
  const dir = mkdtempSync(join(tmpdir(), 'q-'));
  const p = join(dir, 'usage-cache.json');
  writeFileSync(p, JSON.stringify({ fetchedAt, data: {
    five_hour: { utilization: fiveUsed, resets_at: '2026-09-20T23:30:00.000Z' },
    seven_day: { utilization: weekUsed, resets_at: '2026-09-24T20:00:00.000Z' } } }));
  return p;
}
const left = (pct: number) => readQuota(cacheWith(100 - pct, 0));

test('the window that runs out first is the one that decides', () => {
  const q = readQuota(cacheWith(72, 9));
  assert.equal(q.fiveHour, 28);
  assert.equal(q.sevenDay, 91);
  assert.equal(q.remaining, 28, 'plenty of weekly left does not matter when the session is nearly spent');
});

test('the model steps down the ladder as the window empties', () => {
  assert.equal(planFor(left(90)).model, 'fable', 'the best model while there is room for it');
  assert.equal(planFor(left(70)).model, 'fable', '70 is the rung, so it still counts');
  assert.equal(planFor(left(69)).model, 'opus', 'below the top rung, opus, not straight to sonnet');
  assert.equal(planFor(left(50)).model, 'opus');
  assert.equal(planFor(left(49)).model, 'sonnet');
  assert.equal(planFor(left(31)).model, 'sonnet');
});

test('under the floor the work leaves Claude entirely', () => {
  assert.deepEqual(planFor(left(30)), { worker: 'codex' }, '30 left is at the floor, so it saves');
  assert.deepEqual(planFor(left(5)), { worker: 'codex' });
  assert.equal(planFor(left(31)).worker, 'claude');
});

test('the ladder is whatever the settings say', () => {
  const mine = { saverBelow: 50, ladder: [{ atLeast: 95, model: 'opus' }, { atLeast: 60, model: 'haiku' }] };
  assert.equal(planFor(left(96), mine).model, 'opus');
  assert.equal(planFor(left(70), mine).model, 'haiku');
  assert.equal(planFor(left(45), mine).worker, 'codex', 'a floor of 50 saves earlier');
  assert.equal(gearFor(left(96), mine), 'plenty');
  assert.equal(gearFor(left(70), mine), 'normal');
});

test('rungs out of order still rank richest first', () => {
  const jumbled = { saverBelow: 20, ladder: [{ atLeast: 40, model: 'sonnet' }, { atLeast: 90, model: 'fable' }] };
  assert.equal(planFor(left(95), jumbled).model, 'fable');
  assert.equal(planFor(left(50), jumbled).model, 'sonnet');
});

test('an unreadable or missing cache does not pick a gear', () => {
  const q = readQuota(join(tmpdir(), 'definitely-not-here.json'));
  assert.match(q.error ?? '', /no usage cache/);
  assert.equal(gearFor(q), 'unknown');
  assert.equal(planFor(q).worker, 'claude', 'not knowing is not a reason to delegate');
  assert.match(describeQuota(q), /usage unknown/);
  assert.match(short(q), /usage unknown/);
});

test('a stale figure is said to be stale rather than trusted quietly', () => {
  const old = readQuota(cacheWith(72, 9, Date.now() - 90 * 60000));
  assert.match(describeQuota(old), /90 min old/);
  assert.ok(!/min old/.test(describeQuota(readQuota(cacheWith(72, 9)))));
});

test('the status bar names whose percentage it is', () => {
  // "17% codex" read as codex being at 17%; the number is always Claude's
  assert.match(short(left(90)), /Claude 90% → fable/);
  assert.match(short(left(55)), /Claude 55% → opus/);
  assert.match(short(left(25)), /Claude 25% → codex/);
  assert.ok(!/^\S*\s*\d+% codex/.test(short(left(25))), 'the percentage is never left attached to codex');
  assert.match(describeQuota(left(25), DEFAULT_THRESHOLDS), /Gear: saver/);
});

test('parses natural and relative Claude reset timestamps', () => {
  const ts = parseClaudeResetTime('Sep 26 at 8:19am (Europe/Amsterdam)');
  assert.ok(typeof ts === 'number');
  const d = new Date(ts);
  assert.equal(d.getMonth(), 8); // Sep is 8
  assert.equal(d.getDate(), 26);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 19);

  const relTs = parseClaudeResetTime('in 3 hours');
  assert.ok(typeof relTs === 'number');
  assert.ok(relTs > Date.now() + 2 * 3600 * 1000);

  const hourOnlyTs = parseClaudeResetTime('Oct 1 at 10pm (Europe/Amsterdam)');
  assert.ok(typeof hourOnlyTs === 'number');
  const d2 = new Date(hourOnlyTs);
  assert.equal(d2.getMonth(), 9); // Oct is 9
  assert.equal(d2.getDate(), 1);
  assert.equal(d2.getHours(), 22);
  assert.equal(d2.getMinutes(), 0);
});

test('parses Claude CLI usage output into structured quota', () => {
  const raw = 'You are currently using your subscription\n\n'
    + 'Current session: 53% used · resets Sep 26 at 8:19am (Europe/Amsterdam)\n'
    + 'Current week (all models): 12% used · resets Oct 1 at 9:59pm (Europe/Amsterdam)\n';
  const q = parseClaudeUsageOutput(raw);
  assert.equal(q.remaining, 47);
  assert.equal(q.fiveHour, 47);
  assert.equal(q.sevenDay, 88);
  assert.ok(q.fiveHourResetsAt !== undefined);
  assert.ok(q.sevenDayResetsAt !== undefined);
});

