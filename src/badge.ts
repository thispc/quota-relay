/**
 * One way to show a subscription's two windows, for every provider.
 *
 * A bare "3%" did not say whether it was the 5-hour window or the week (Pulkit, 11 Oct 2026), and each provider
 * had grown its own layout. Every badge now reads `Name 5h 86% · 7d 3%`: both windows, always labelled, always in
 * that order. A window that is running low also says when it comes back, since that is the next thing to ask.
 */
export interface Windows {
  /** Percent left of the 5-hour window. */
  fiveHour?: number;
  fiveHourResetsAt?: number;
  /** Percent left of the weekly window. */
  sevenDay?: number;
  sevenDayResetsAt?: number;
}

export type Level = 'ok' | 'low' | 'critical' | 'unknown';

/** At or under this much left a window is "low": coloured, and shown with its reset time. */
export const LOW = 30;
export const CRITICAL = 15;

const pct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** "42m", "3h 10m", "2d 4h": how long until a reset. */
export function until(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function part(tag: string, left: number | undefined, resetsAt: number | undefined, now: number): string | undefined {
  if (left === undefined) return undefined;
  const p = pct(left);
  return `${tag} ${p}%${p <= LOW && resetsAt && resetsAt > now ? ` ↻${until(resetsAt, now).split(' ')[0]}` : ''}`;
}

/** The status bar text after the name: "5h 86% · 7d 3% ↻2d", or "—" when nothing is known. */
export function windowsText(w: Windows | undefined, now = Date.now()): string {
  const parts = [part('5h', w?.fiveHour, w?.fiveHourResetsAt, now), part('7d', w?.sevenDay, w?.sevenDayResetsAt, now)].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

/** The tighter window decides the colour: it is the one that stops the work. */
export function levelOf(w: Windows | undefined): Level {
  const both = [w?.fiveHour, w?.sevenDay].filter((n): n is number => typeof n === 'number');
  if (!both.length) return 'unknown';
  const min = Math.min(...both);
  return min <= CRITICAL ? 'critical' : min <= LOW ? 'low' : 'ok';
}

/** A ten-step meter for tooltips: "▰▰▰▰▰▰▰▰▱▱". */
export function meter(left: number | undefined): string {
  if (left === undefined) return '▱'.repeat(10);
  const on = Math.round(pct(left) / 10);
  return '▰'.repeat(on) + '▱'.repeat(10 - on);
}

function clock(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time
       : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

function cell(left: number | undefined, resetsAt: number | undefined, now: number): string {
  if (left === undefined) return '—';
  return `\`${meter(left)}\` **${pct(left)}%**${resetsAt && resetsAt > now ? `<br>back in ${until(resetsAt, now)} · ${clock(resetsAt)}` : ''}`;
}

export interface Row { name: string; windows?: Windows; note?: string; active?: boolean; }

/** The tooltip body every badge shares: one row per subscription, the same two columns. */
export function tooltipTable(title: string, rows: Row[], footer: string[] = [], now = Date.now()): string {
  const lines = [`**${title}** &nbsp; _percent left_`, '', '| | 5-hour | Week |', '|:--|:--|:--|'];
  for (const r of rows) {
    const name = `${r.active ? '● ' : ''}${r.name}`;
    lines.push(r.note ? `| ${name} | ${r.note} | |`
                      : `| ${name} | ${cell(r.windows?.fiveHour, r.windows?.fiveHourResetsAt, now)} | ${cell(r.windows?.sevenDay, r.windows?.sevenDayResetsAt, now)} |`);
  }
  return [...lines, '', ...footer.map(f => `${f}\n`)].join('\n');
}
