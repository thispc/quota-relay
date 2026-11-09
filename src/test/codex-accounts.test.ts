import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccount, CodexLimits, codexAccounts, codexDue, limitsFromCodex, pickCodex, usable } from '../codex-accounts';
import { CodexPool, applyCodexRead } from '../codex-pool';

const T = Date.parse('2026-11-09T20:00:00Z'), min = 60_000, h = 60 * min;

test('an account Codex says is out is out, whatever the percentages say', () => {
  // this is the case the badge got wrong: the week read 36% left from an old snapshot while Codex refused work
  const l = limitsFromCodex({ ordinaryUsageAllowed: false, rateLimits: {
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: T / 1000 + 5 * 3600 },
    secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: T / 1000 + 73 * 3600 },
    rateLimitReachedType: 'rate_limit_reached' } });
  assert.deepEqual([l.fiveHour, l.sevenDay, l.allowed], [100, 36, false]);
  assert.equal(usable(l), false);
});

test('Codex reports percent used and seconds; the badge wants percent left and milliseconds', () => {
  const l = limitsFromCodex({ ordinaryUsageAllowed: true, rateLimits: {
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_800_500_000 }, planType: 'plus' } });
  assert.deepEqual([l.fiveHour, l.fiveHourResetsAt, l.sevenDay, l.sevenDayResetsAt, l.plan], [88, 1_800_000_000_000, 0, 1_800_500_000_000, 'plus']);
});

test('windows are told apart by length, not by which slot they came in', () => {
  const l = limitsFromCodex({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080 }, secondary: null } });
  assert.deepEqual([l.fiveHour, l.sevenDay], [undefined, 60], 'a lone weekly window is the week');
});

test('with no verdict from Codex, an empty window means out', () => {
  assert.equal(usable({ fiveHour: 0, sevenDay: 50 }), false);
  assert.equal(usable({ fiveHour: 20, sevenDay: 50 }), true);
  assert.equal(usable({ signedOut: true }), false);
  assert.equal(usable(undefined), false);
});

const acc = (id: string, mac = false): CodexAccount => ({ id, label: id, home: `/h/${id}`, mac });

test("this Mac's login takes the work while it can run", () => {
  const p = pickCodex([acc('mac', true), acc('has:account_2')], { mac: { allowed: true, sevenDay: 20 }, 'has:account_2': { allowed: true, sevenDay: 100 } });
  assert.equal(p?.id, 'mac');
});

test("when this Mac's login is out, work goes to an account with room", () => {
  const p = pickCodex([acc('mac', true), acc('has:account_2')], { mac: { allowed: false }, 'has:account_2': { allowed: true, sevenDay: 100 } });
  assert.equal(p?.id, 'has:account_2');
});

test('of two spare accounts, the one whose week ends first goes first', () => {
  const p = pickCodex([acc('mac', true), acc('a'), acc('b')], {
    mac: { allowed: false }, a: { allowed: true, sevenDay: 90, sevenDayResetsAt: T + 100 * h }, b: { allowed: true, sevenDay: 80, sevenDayResetsAt: T + 20 * h } });
  assert.equal(p?.id, 'b');
});

test('an account not read yet is tried before giving up', () => {
  const p = pickCodex([acc('mac', true), acc('has:account_2')], { mac: { allowed: false } });
  assert.equal(p?.id, 'has:account_2');
});

test("HAS's accounts are found in slot order, and only folders Codex signed in to count", () => {
  const root = mkdtempSync(join(tmpdir(), 'has-'));
  for (const slot of ['account_10', 'account_2', 'account_3']) mkdirSync(join(root, slot));
  writeFileSync(join(root, 'account_10', 'auth.json'), '{}');
  writeFileSync(join(root, 'account_2', 'auth.json'), '{}');
  const list = codexAccounts(root, '/h/mac');
  assert.deepEqual(list.map(a => a.id), ['mac', 'has:account_2', 'has:account_10'], 'account_3 has no login yet');
  assert.equal(list[1].home, join(root, 'account_2'));
  assert.deepEqual(codexAccounts(join(root, 'nope'), '/h/mac').map(a => a.id), ['mac'], 'no HAS: just this Mac');
});

test('a failed read keeps the last numbers; signed out replaces them', () => {
  const good = applyCodexRead(undefined, { allowed: true, sevenDay: 40 }, T);
  const failed = applyCodexRead(good, { error: 'codex did not answer in time' }, T + min);
  assert.deepEqual([failed.limits?.sevenDay, failed.at, failed.fails], [40, T, 1]);
  assert.equal(applyCodexRead(failed, { signedOut: true, error: 'signed out' }, T + 2 * min).limits?.signedOut, true);
});

test('reads are spaced: 5 minutes for the account in use, 15 for others, backing off after failures', () => {
  assert.equal(codexDue({ at: T }, true, T + 4 * min), false);
  assert.equal(codexDue({ at: T }, true, T + 5 * min), true);
  assert.equal(codexDue({ at: T }, false, T + 10 * min), false);
  assert.equal(codexDue({ at: T, triedAt: T, fails: 3 }, true, T + 7 * min), false);
  assert.equal(codexDue({ at: T, triedAt: T, fails: 3 }, true, T + 8 * min), true);
});

function pool(limits: Record<string, CodexLimits>) {
  let saved: Record<string, unknown> = {};
  const reads: string[] = [];
  const p = new CodexPool(() => 'codex', () => undefined, () => [acc('mac', true), acc('has:account_2')],
    async home => { reads.push(home); return limits[home.replace('/h/', '')] ?? { error: 'x' }; },
    { load: async () => JSON.parse(JSON.stringify(saved)), save: async r => { saved = JSON.parse(JSON.stringify(r)); } });
  return { p, reads };
}

test('the pool reads every account and learns who each one is', async () => {
  const { p, reads } = pool({ mac: { allowed: false, sevenDay: 0, email: 'a@x.com' }, 'has:account_2': { allowed: true, sevenDay: 100, email: 'b@x.com' } });
  await p.refresh();
  assert.deepEqual(reads, ['/h/mac', '/h/has:account_2']);
  assert.equal(p.picked()?.id, 'has:account_2');
  assert.equal(p.accounts[1].email, 'b@x.com');
  await p.refresh();
  assert.equal(reads.length, 2, 'nothing is due again straight away');
});

test('a task that runs out moves to the next account, and none is left after the last', async () => {
  const { p } = pool({ mac: { allowed: true, sevenDay: 50 }, 'has:account_2': { allowed: true, sevenDay: 100 } });
  await p.refresh();
  assert.equal(p.markSpent('/h/mac')?.id, 'has:account_2');
  assert.equal(p.markSpent('/h/has:account_2'), undefined, 'both spent: the manager falls back to another provider');
});
