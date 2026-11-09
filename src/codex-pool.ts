import {
  CodexAccount, CodexLimits, CodexReading, codexAccounts, codexDue, loadCodexReadings, pickCodex, readCodexLimits,
  saveCodexReadings
} from './codex-accounts';

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
              private readonly store = { load: loadCodexReadings, save: saveCodexReadings }) {
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
