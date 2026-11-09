import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { augmentedPath, withLock } from './accounts';
import {
  CodexAccount, CodexLimits, CodexReading, codexAccounts, codexDue, loadCodexReadings, pickCodex, readCodexLimits,
  saveCodexReadings, usable
} from './codex-accounts';

/** Run `hire` (Hire a Service's command) and give back what it printed, or throw what it said. */
export type Hire = (args: string[]) => Promise<string>;
const hireCommand: Hire = args => new Promise((resolve, reject) => {
  const bin = join(homedir(), '.local', 'bin', 'hire');
  execFile(bin, args, { env: { ...process.env, PATH: augmentedPath() }, timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim().replace(/^hire:\s*/, '')));
    else resolve(stdout.trim());
  });
});

/**
 * Every Codex account, read on a schedule and shared between windows, and the one Codex work should go to.
 */
export class CodexPool {
  private readings: Record<string, CodexReading> = {};
  private busy?: Promise<void>;
  accounts: CodexAccount[] = [];

  constructor(private readonly command: () => string, private readonly log: (line: string) => void = () => undefined,
              private readonly list: () => CodexAccount[] = () => codexAccounts(),
              private readonly read: (home: string, cmd: string) => Promise<CodexLimits> = readCodexLimits,
              private readonly store = { load: loadCodexReadings, save: saveCodexReadings },
              private readonly hire: Hire = hireCommand,
              private readonly lock: <T>(fn: () => Promise<T>) => Promise<T> = withLock) {
    this.accounts = this.list();
  }

  limits(id: string): CodexLimits | undefined { return this.readings[id]?.limits; }
  reading(id: string): CodexReading | undefined { return this.readings[id]; }
  all(): Record<string, CodexLimits | undefined> {
    return Object.fromEntries(this.accounts.map(a => [a.id, this.readings[a.id]?.limits]));
  }

  /** Where Codex work goes now. */
  picked(): CodexAccount | undefined { return pickCodex(this.accounts, this.all()); }

  /** The account Codex just said is spent: off the list until it is read again. Returns where work goes next. */
  markSpent(home: string | undefined): CodexAccount | undefined {
    const a = this.accounts.find(x => x.home === home);
    if (a) {
      const r = this.readings[a.id] ?? { at: Date.now() };
      // until the next scheduled read says otherwise
      this.readings[a.id] = { ...r, limits: { ...(r.limits ?? {}), allowed: false, reached: 'rate_limit_reached' }, at: Date.now() };
      void this.store.save(this.readings).catch(() => undefined);
    }
    const next = this.picked();
    return next && next.home !== home ? next : undefined;
  }

  /**
   * Make a HAS account this Mac's login, through HAS: the two logins trade places in their folders, so the
   * readings trade places too. Then both are read again.
   */
  async use(id: string): Promise<string> {
    const a = this.accounts.find(x => x.id === id);
    if (!a || a.mac) throw new Error('that account is already this Mac\'s login');
    const said = await this.hire(['ai', 'use', 'codex', id.replace(/^has:/, '')]);
    const mac = this.accounts.find(x => x.mac)!;
    const all = { ...(await this.store.load()), ...this.readings };
    [all[mac.id], all[a.id]] = [all[a.id], all[mac.id]];
    [mac.email, mac.plan, a.email, a.plan] = [a.email, a.plan, mac.email, mac.plan];
    for (const k of [mac.id, a.id]) if (all[k]) all[k] = { ...all[k]!, at: 0 };   // read both again soon
    this.readings = all;
    await this.store.save(all).catch(() => undefined);
    return said;
  }

  /**
   * When this Mac's login cannot run and an added account can, switch to it. One window at a time, and only after
   * this Mac's login is read again: a window with an old reading must not swap the spent login back in.
   */
  async autoUse(): Promise<{ to: CodexAccount; said: string } | undefined> {
    const mac = this.accounts.find(x => x.mac);
    if (!mac || usable(this.limits(mac.id)) || !this.limits(mac.id)) return undefined;
    return this.lock(async () => {
      this.readings = { ...this.readings, ...(await this.store.load()) };
      const now = await this.read(mac.home, this.command()).catch(() => undefined);
      if (!now || now.error || usable(now)) {
        if (now && !now.error) this.readings[mac.id] = applyCodexRead(this.readings[mac.id], now);
        return undefined;
      }
      const to = this.picked();
      if (!to || to.mac) return undefined;
      const said = await this.use(to.id);
      return { to: this.accounts.find(x => x.mac)!, said };
    });
  }

  /**
   * Read what is due, one account at a time (each read starts a Codex process). A read that fails keeps the
   * last numbers and backs off; signed out replaces them.
   */
  refresh(force = false): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      try {
        this.accounts = this.list();
        this.readings = { ...this.readings, ...(await this.store.load()) };   // another window may have read already
        const inUse = this.picked()?.id;
        for (const a of this.accounts) {
          const r = this.readings[a.id];
          if (force ? Date.now() - (r?.triedAt ?? 0) < 20_000 : !codexDue(r, a.id === inUse || a.mac)) continue;
          // say so before asking, so another window does not start the same Codex process
          this.readings = { ...(await this.store.load()), ...this.readings, [a.id]: { ...(r ?? { at: 0 }), triedAt: Date.now() } };
          await this.store.save(this.readings).catch(() => undefined);
          const got = await this.read(a.home, this.command()).catch(e => ({ error: String(e) }) as CodexLimits);
          this.readings[a.id] = applyCodexRead(this.readings[a.id], got);
          if (got.email) { a.email = got.email; a.plan = got.plan; }
          if (got.error && !got.signedOut) this.log(`codex ${a.label}: ${got.error}; keeping the last reading`);
        }
        for (const a of this.accounts) {
          const l = this.readings[a.id]?.limits;
          if (l?.email) { a.email = l.email; a.plan = l.plan; }
        }
        await this.store.save(this.readings).catch(() => undefined);
      } finally { this.busy = undefined; }
    })();
    return this.busy;
  }
}

export function applyCodexRead(prev: CodexReading | undefined, got: CodexLimits, now = Date.now()): CodexReading {
  if (!got.error || got.signedOut) return { limits: got, at: now, triedAt: now };
  return { limits: prev?.limits, at: prev?.limits ? prev.at : 0, triedAt: now, fails: (prev?.fails ?? 0) + 1 };
}
