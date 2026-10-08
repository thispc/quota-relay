import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Account, Reading, chooseAccount, fingerprint, keychainService, slug } from '../accounts';
import { WorkerManager } from '../manager';
import { WorkerAdapter, TaskHandle, TaskRequest, AuthStatus, TaskResult } from '../models';
import { Quota, quotaFromUsage } from '../quota';

const acc = (id: string, extra: Partial<Account> = {}): Account => ({ id, label: id, dir: `/tmp/${id}`, ...extra });
const at = (fiveHour: number, sevenDay = 100, sevenDayResetsAt?: number): Reading => {
  const q: Quota = { fiveHour, sevenDay, remaining: Math.min(fiveHour, sevenDay), sevenDayResetsAt };
  return { quota: q, at: Date.now() };
};

test('the Keychain item is named the way Claude Code names it', () => {
  assert.equal(keychainService(), 'Claude Code-credentials', 'the default folder has the plain name');
  const dir = '/Users/x/.claude-accounts/work';
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.equal(keychainService(dir), `Claude Code-credentials-${hash}`);
});

test('the active account is drained before moving', () => {
  const r = chooseAccount([acc('a'), acc('b')], 'a', { a: at(40), b: at(100) });
  assert.equal(r.switch, false, 'a still has room, so b keeps filling');
  assert.equal(r.id, 'a');
});

test('nearly spent, it moves to the account with room', () => {
  const r = chooseAccount([acc('a'), acc('b')], 'a', { a: at(4), b: at(100) });
  assert.deepEqual([r.switch, r.id], [true, 'b']);
});

test('the weekly window counts as much as the 5-hour one', () => {
  const r = chooseAccount([acc('a'), acc('b')], 'a', { a: at(90, 3), b: at(100) });
  assert.deepEqual([r.switch, r.id], [true, 'b'], '90% of the session is no use with 3% of the week left');
});

test('a move has to be worth it', () => {
  const r = chooseAccount([acc('a'), acc('b')], 'a', { a: at(4), b: at(12) });
  assert.equal(r.switch, false, 'b at 12% would be spent within minutes; stay and let a reset');
  assert.match(r.reason, /no other account has room/);
});

test('of two fresh accounts, the one whose week ends first is spent first', () => {
  const soon = Date.now() + 86_400_000, later = Date.now() + 5 * 86_400_000;
  const r = chooseAccount([acc('a'), acc('b'), acc('c')], 'a', { a: at(0), b: at(100, 80, later), c: at(100, 80, soon) });
  assert.equal(r.id, 'c', 'what c has left this week is lost at its reset; b carries on');
});

test('a signed-out active account is left for any usable one', () => {
  const r = chooseAccount([acc('a', { needsLogin: true }), acc('b')], 'a', { a: at(100), b: {} as Reading });
  assert.deepEqual([r.switch, r.id], [true, 'b'], 'even with b unread, it beats an account that cannot run');
});

test('signed-out accounts are never picked', () => {
  const r = chooseAccount([acc('a'), acc('b', { needsLogin: true })], 'a', { a: at(1), b: at(100) });
  assert.equal(r.switch, false);
});

test('account ids are short and unique', () => {
  assert.equal(slug('Work Max', []), 'work-max');
  assert.equal(slug('me@example.com', []), 'me');
  assert.equal(slug('work', ['work']), 'work-2');
});

test('a fingerprint follows the refresh token and reveals nothing', () => {
  const f = fingerprint({ claudeAiOauth: { refreshToken: 'secret-token' } });
  assert.equal(f?.length, 12);
  assert.ok(!f!.includes('secret'));
  assert.equal(fingerprint(undefined), undefined);
});

test('usage from the API reads the same as the cache file', () => {
  const q = quotaFromUsage({ five_hour: { utilization: 97, resets_at: '2026-10-08T21:30:00Z' }, seven_day: { utilization: 60, resets_at: null } });
  assert.deepEqual([q.fiveHour, q.sevenDay, q.remaining], [3, 40, 3]);
  assert.equal(q.resetsAt, Date.parse('2026-10-08T21:30:00Z'));
  assert.equal(q.sevenDayResetsAt, undefined);
});

class Limited implements WorkerAdapter {
  calls = 0;
  constructor(public readonly id: 'codex' | 'claude', private readonly limitedTimes: number) {}
  run(request: TaskRequest): TaskHandle {
    const spent = this.calls++ < this.limitedTimes;
    const promise = Promise.resolve<TaskResult>({ worker: this.id, exitCode: spent ? 1 : 0, output: spent ? 'usage limit reached' : request.prompt,
                                                  durationMs: 1, rateLimited: spent });
    return { promise, cancel() {} };
  }
  checkAuth(): Promise<AuthStatus> { return Promise.resolve({ authenticated: true, detail: 'ok' }); }
}

test('a spent Claude moves to the next account instead of leaving Claude', async () => {
  const claude = new Limited('claude', 1), codex = new Limited('codex', 0);
  const manager = new WorkerManager({ claude, codex });
  manager.onSpent = async () => true;
  const r = await manager.run({ prompt: 'hi', cwd: '.', worker: 'auto' }, () => {});
  assert.equal(r.worker, 'claude');
  assert.equal(claude.calls, 2, 'run again on the new account');
  assert.equal(codex.calls, 0);
});

test('with no account to move to, it falls back as before', async () => {
  const claude = new Limited('claude', 5), codex = new Limited('codex', 0);
  const manager = new WorkerManager({ claude, codex });
  manager.quotaPlan = () => ({ worker: 'claude' });
  manager.onSpent = async () => false;
  const r = await manager.run({ prompt: 'hi', cwd: '.', worker: 'auto' }, () => {});
  assert.equal(r.worker, 'codex');
});

test('account moves are capped, so a limit every account shares cannot loop', async () => {
  const claude = new Limited('claude', 99), codex = new Limited('codex', 0);
  const manager = new WorkerManager({ claude, codex });
  manager.quotaPlan = () => ({ worker: 'claude' });
  manager.onSpent = async () => true;
  const r = await manager.run({ prompt: 'hi', cwd: '.', worker: 'auto' }, () => {});
  assert.equal(claude.calls, 4, 'the first try and three moves');
  assert.equal(r.worker, 'codex');
});
