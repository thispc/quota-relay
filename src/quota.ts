import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How much of Claude's window is left, and what that should change.
 *
 * Claude Code keeps its own usage in ~/.claude/usage-cache.json and refreshes it as it works, so the number is
 * read rather than guessed or counted locally. Two thresholds decide the gear:
 *
 *   plenty  (>= saver + a margin)  the best model, whatever that costs
 *   normal                          the everyday model
 *   saver   (<= saverBelow)         hand the work to another provider instead of spending the rest
 *
 * Pulkit, 20 Sep 2026: "keep some to orchestrate codex instead if its less than 30, more than 70 uses fable".
 */
export type Gear = 'plenty' | 'normal' | 'saver' | 'unknown';

/** One rung: with at least this much of the window left, this model is the one to use. */
export interface Rung { atLeast: number; model: string; }

export interface QuotaThresholds {
  /** Richest model first. The first rung whose `atLeast` is met wins. */
  ladder: Rung[];
  /** At or below this much left, stop spending Claude and delegate instead. */
  saverBelow: number;
}

// Fable is the strongest, then Opus, then Sonnet; spending the best model on the last of a window is what
// runs it out (Pulkit, 20 Sep 2026: "after fable opus is better no? why sonnet?").
export const DEFAULT_THRESHOLDS: QuotaThresholds = {
  ladder: [{ atLeast: 70, model: 'fable' }, { atLeast: 50, model: 'opus' }, { atLeast: 30, model: 'sonnet' }],
  saverBelow: 30
};

/** The rungs in order, richest first, ignoring any rung at or under the saver floor. */
export function rungs(t: QuotaThresholds): Rung[] {
  return [...t.ladder].sort((a, b) => b.atLeast - a.atLeast);
}

export interface Quota {
  /** Percent of the window still available, lowest of the windows that matter. */
  remaining?: number;
  fiveHour?: number;
  fiveHourResetsAt?: number;
  sevenDay?: number;
  sevenDayResetsAt?: number;
  resetsAt?: number;
  /** Minutes since Claude last refreshed the figure. */
  ageMinutes?: number;
  error?: string;
}

const CACHE = join(homedir(), '.claude', 'usage-cache.json');

export function parseClaudeResetTime(dateStr: string): number | undefined {
  if (!dateStr) return undefined;
  const direct = Date.parse(dateStr);
  if (!isNaN(direct)) return direct;

  const relMatch = dateStr.match(/in\s+(\d+)\s*(m|min|minute|h|hour|d|day)/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms = unit.startsWith('h') ? amount * 3600000 : unit.startsWith('d') ? amount * 86400000 : amount * 60000;
    return Date.now() + ms;
  }

  const match = dateStr.match(/([A-Za-z]+)\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (match) {
    const [, monthStr, dayStr, hourStr, minStr, ampm] = match;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(monthStr.toLowerCase().slice(0, 3));
    if (month >= 0) {
      const now = new Date();
      let hour = parseInt(hourStr, 10);
      if (ampm.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
      const minute = minStr ? parseInt(minStr, 10) : 0;
      const day = parseInt(dayStr, 10);
      const date = new Date(now.getFullYear(), month, day, hour, minute);
      if (date.getTime() < now.getTime() - 86400000) {
        date.setFullYear(now.getFullYear() + 1);
      }
      return date.getTime();
    }
  }
  return undefined;
}

export function parseClaudeUsageOutput(raw: string): Quota {
  let text = raw;
  try {
    const json = JSON.parse(raw);
    if (typeof json.result === 'string') {
      text = json.result;
    }
  } catch {}

  const sessionMatch = text.match(/Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n\r]+))?/i);
  const weekMatch = text.match(/Current week[^:]*:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n\r]+))?/i);

  if (!sessionMatch && !weekMatch) {
    return { error: 'Could not parse Claude CLI usage output' };
  }

  const sessionUsed = sessionMatch ? parseInt(sessionMatch[1], 10) : undefined;
  const weekUsed = weekMatch ? parseInt(weekMatch[1], 10) : undefined;

  const fiveHour = sessionUsed !== undefined ? Math.max(0, 100 - sessionUsed) : undefined;
  const sevenDay = weekUsed !== undefined ? Math.max(0, 100 - weekUsed) : undefined;
  const both = [fiveHour, sevenDay].filter((n): n is number => typeof n === 'number');
  const remaining = both.length ? Math.min(...both) : undefined;

  const fiveHourResetsAt = sessionMatch?.[2] ? parseClaudeResetTime(sessionMatch[2].trim()) : undefined;
  const sevenDayResetsAt = weekMatch?.[2] ? parseClaudeResetTime(weekMatch[2].trim()) : undefined;
  const resetsAt = (fiveHour ?? 100) <= (sevenDay ?? 100) ? fiveHourResetsAt : sevenDayResetsAt;

  return {
    remaining,
    fiveHour,
    sevenDay,
    fiveHourResetsAt,
    sevenDayResetsAt,
    resetsAt,
    ageMinutes: 0
  };
}

/** The shape both ~/.claude/usage-cache.json and /api/oauth/usage carry. */
export interface UsageWindows {
  five_hour?: { utilization?: number; resets_at?: string | null } | null;
  seven_day?: { utilization?: number; resets_at?: string | null } | null;
}

export function quotaFromUsage(data: UsageWindows, fetchedAt?: number): Quota {
  const five = data.five_hour ?? undefined, week = data.seven_day ?? undefined;
  const left = (u?: number) => (typeof u === 'number' ? Math.max(0, 100 - u) : undefined);
  const fiveHour = left(five?.utilization), sevenDay = left(week?.utilization);
  const both = [fiveHour, sevenDay].filter((n): n is number => typeof n === 'number');
  // the window that runs out first is the one that decides
  const tightest = both.length ? Math.min(...both) : undefined;
  const at = (s?: string | null) => (s ? Date.parse(s) : undefined);
  return {
    remaining: tightest, fiveHour, sevenDay,
    fiveHourResetsAt: at(five?.resets_at), sevenDayResetsAt: at(week?.resets_at),
    resetsAt: (fiveHour ?? 100) <= (sevenDay ?? 100) ? at(five?.resets_at) : at(week?.resets_at),
    ageMinutes: fetchedAt ? (Date.now() - fetchedAt) / 60000 : 0
  };
}

/** What Claude Code last wrote to its own usage cache: the fallback when the account cannot be asked. */
export function readQuota(path = CACHE): Quota {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); }
  catch { return { error: 'no usage cache yet; run Claude Code once so it writes one' }; }
  try {
    const j = JSON.parse(raw) as { fetchedAt?: number; data?: UsageWindows };
    return quotaFromUsage(j.data ?? {}, j.fetchedAt);
  } catch { return { error: 'the usage cache is not readable JSON' }; }
}

export function gearFor(q: Quota, t: QuotaThresholds = DEFAULT_THRESHOLDS): Gear {
  if (typeof q.remaining !== 'number') return 'unknown';
  if (q.remaining <= t.saverBelow) return 'saver';
  const top = rungs(t)[0];
  if (top && q.remaining >= top.atLeast) return 'plenty';
  return 'normal';
}

/**
 * Who should take the next turn, and on which model.
 *
 * Below the saver floor the work goes to another provider. Above it, the richest rung whose threshold is met
 * wins, so the model steps down as the window empties instead of burning the best one to the last drop.
 */
export function planFor(q: Quota, t: QuotaThresholds = DEFAULT_THRESHOLDS): { worker: 'claude' | 'codex'; model?: string } {
  if (typeof q.remaining !== 'number') return { worker: 'claude' };
  if (q.remaining <= t.saverBelow) return { worker: 'codex' };
  const hit = rungs(t).find(r => q.remaining! >= r.atLeast);
  return { worker: 'claude', model: hit?.model ?? rungs(t).at(-1)?.model };
}

/**
 * A few characters for the status bar.
 *
 * "17% codex" read as if codex were at 17% (Pulkit, 20 Sep 2026). The percentage is Claude's, and the arrow
 * says where the work goes, so both halves have to be named.
 */
export function short(q: Quota, t: QuotaThresholds = DEFAULT_THRESHOLDS): string {
  if (typeof q.remaining !== 'number') return '$(question) Claude usage unknown';
  const plan = planFor(q, t);
  const icon = plan.worker === 'codex' ? '$(arrow-swap)' : q.remaining >= (rungs(t)[0]?.atLeast ?? 70) ? '$(zap)' : '$(pulse)';
  const who = plan.worker === 'codex' ? 'codex' : plan.model ?? 'claude';
  return `${icon} Claude ${q.remaining}% \u2192 ${who}`;
}

export function describe(q: Quota, t: QuotaThresholds = DEFAULT_THRESHOLDS): string {
  if (q.error) return `Claude usage unknown: ${q.error}`;
  const gear = gearFor(q, t);
  const plan = planFor(q, t);
  const back = q.resetsAt ? new Date(q.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown';
  const stale = (q.ageMinutes ?? 0) > 30 ? ` (figure is ${Math.round(q.ageMinutes!)} min old)` : '';
  const where = plan.worker === 'codex' ? 'codex, to save the rest' : `claude (${plan.model})`;
  return `Claude ${q.remaining}% left (5h ${q.fiveHour ?? '?'}%, 7d ${q.sevenDay ?? '?'}%), resets ${back}${stale}. `
       + `Gear: ${gear} → ${where}.`;
}
