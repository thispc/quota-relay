import { TaskRequest, TaskResult, WorkerAdapter, WorkerId, UsageSnapshot, TaskHandle, StreamChunk, WorkerSelection } from './models';
import { EventEmitter } from 'node:events';

/** A failure the other worker would hit too: trying it again there only spends more quota. */
function worthRetrying(reason: unknown): boolean {
  const text = String((reason as { message?: string })?.message ?? reason);
  return !/cancel|abort|not authenticated|unauthori[sz]ed|invalid (argument|model|flag)|unknown option|no such file/i.test(text);
}

export class WorkerManager {
  readonly events = new EventEmitter();
  private readonly usage = new Map<WorkerId, UsageSnapshot>();
  private active = new Map<number, { worker: WorkerId; handle: TaskHandle }>();
  private nextId = 1;
  constructor(private readonly adapters: Record<WorkerId, WorkerAdapter>, private readonly maxConcurrent = 1,
              private readonly failureThreshold = 3, private readonly usageThreshold = 0,
              /** How long to rest a worker whose CLI reported a limit without naming a reset time. */
              private readonly limitedCooldownMs = 30 * 60_000) {
    for (const id of Object.keys(adapters) as WorkerId[]) this.usage.set(id, { worker: id, running: 0, completed: 0, failures: 0, usage: { state: 'unknown' }, usageThresholdReached: false, available: true });
  }
  snapshots(): UsageSnapshot[] { return [...this.usage.values()].map(s => ({ ...s })); }
  cancelActive(): void { for (const task of this.active.values()) task.handle.cancel(); }
  cancelTask(taskId: number): void { this.active.get(taskId)?.handle.cancel(); }
  activeTasks(): number { return this.active.size; }
  /** A worker the CLI reported as out of quota, until its window is up. */
  private limited(s: UsageSnapshot, now = Date.now()): boolean {
    if (!s.limitedUntil) return false;
    if (s.limitedUntil > now) return true;
    s.limitedUntil = undefined;          // the window passed: let it back in
    s.usageThresholdReached = false;
    return false;
  }

  /**
   * Set by the extension: a worker's subscription is spent, so try another account on the same provider.
   * Resolves true when it moved to one, and the task is retried on the same worker instead of falling back.
   */
  onSpent?: (worker: WorkerId, resetAt?: number) => Promise<boolean>;

  /** Set by the extension so routing can follow how much of Claude's window is left. */
  quotaPlan?: () => { worker: WorkerId; model?: string } | undefined;

  /** Who auto-routing would pick right now, so a caller can prepare that worker's prompt. */
  preferredWorker(): WorkerId | undefined {
    const wanted = this.quotaPlan?.()?.worker;
    if (wanted) {
      const s = this.usage.get(wanted);
      if (s && s.available && !this.limited(s)) return wanted;   // the gear's choice, unless it is spent
    }
    return this.peekNext([]);
  }

  /** Who would take the task next, for the message that says where it is going. */
  private peekNext(excluded: WorkerId[]): WorkerId | undefined {
    try { return this.choose('auto', excluded); } catch { return undefined; }
  }

  private choose(selection: WorkerSelection = 'auto', excluded: WorkerId[] = []): WorkerId {
    if (selection !== 'auto') return selection;
    const now = Date.now();
    const wanted = this.quotaPlan?.()?.worker;
    if (wanted && !excluded.includes(wanted)) {
      const s = this.usage.get(wanted);
      if (s && s.available && s.failures < this.failureThreshold && !this.limited(s, now)) return wanted;
    }
    const candidates = [...this.usage.values()].filter(s =>
      s.available &&
      s.failures < this.failureThreshold &&
      !this.limited(s, now) &&
      !(this.usageThreshold > 0 && s.completed >= this.usageThreshold) &&
      !excluded.includes(s.worker)
    );
    if (!candidates.length) {
      const next = Math.min(...[...this.usage.values()].map(s => s.limitedUntil ?? Infinity));
      throw new Error(Number.isFinite(next)
        ? `Every worker is out of quota. The first comes back at ${new Date(next).toLocaleTimeString()}.`
        : 'No healthy workers are available.');
    }
    return candidates.sort((a, b) => (a.running - b.running) || (a.failures - b.failures) || ((a.lastUsed ?? 0) - (b.lastUsed ?? 0)))[0].worker;
  }
  run(request: TaskRequest, onChunk: (chunk: StreamChunk) => void): Promise<TaskResult> {
    if (this.active.size >= this.maxConcurrent) throw new Error(`Concurrency limit reached (${this.maxConcurrent}).`);
    const attempts: WorkerId[] = [];
    const candidates = request.worker && request.worker !== 'auto' ? [request.worker] : [...this.usage.keys()];
    let accountMoves = 0;
    const attempt = (index: number, again?: WorkerId): Promise<TaskResult> => {
      const worker = again ?? (request.worker && request.worker !== 'auto' ? request.worker : this.choose('auto', attempts));
      if (!again) attempts.push(worker);
      const stats = this.usage.get(worker)!; stats.running++;
      const taskId = this.nextId++;
      const handle = this.adapters[worker].run({ ...request, worker }, onChunk);
      this.active.set(taskId, { worker, handle });
      this.events.emit('started', { taskId, worker, request });
      return handle.promise.then(async result => {
        stats.running--; stats.completed++; stats.lastUsed = Date.now();
        stats.usage = { state: 'estimated', completedEstimate: stats.completed };
        stats.usageThresholdReached = this.usageThreshold > 0 && stats.completed >= this.usageThreshold;
        this.active.delete(taskId);
        if (result.rateLimited && accountMoves < 3 && this.onSpent && await this.onSpent(worker, result.resetAt).catch(() => false)) {
          // another subscription on the same provider took over: same worker, fresh window. The session id
          // stays valid because the history lives on this machine, not in the account.
          accountMoves++;
          this.events.emit('finished', { taskId, result });
          return attempt(index, worker);
        }
        if (result.rateLimited) {
          // the subscription's window is spent, which says nothing about this worker's health
          stats.limitedUntil = result.resetAt ?? Date.now() + this.limitedCooldownMs;
          stats.usageThresholdReached = true;
          const next = this.peekNext(attempts.concat(worker));
          this.events.emit('limited', { worker, until: stats.limitedUntil, next, reason: result.output.trim().split('\n').pop() });
        } else if (result.exitCode !== 0) {
          stats.failures++; stats.available = stats.failures < this.failureThreshold;
        }
        this.events.emit('finished', { taskId, result });
        // fall back for a spent window or a worker-specific failure, never for a request the other worker
        // would reject the same way (bad flag, bad model, not signed in)
        if (result.exitCode !== 0 && index + 1 < candidates.length
            && (result.rateLimited || worthRetrying(result.output))) return attempt(index + 1);
        return { ...result, attempts };
      }, error => {
        stats.running--; this.active.delete(taskId);
        const retry = worthRetrying(error);
        if (retry) { stats.failures++; stats.available = stats.failures < this.failureThreshold; }
        this.events.emit('failed', { taskId, error });
        // a cancelled task is the user's decision, not a worker fault: never hand it to the next one
        if (retry && index + 1 < candidates.length) return attempt(index + 1);
        throw error;
      });
    };
    return attempt(0);
  }
}
