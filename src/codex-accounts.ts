import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { augmentedPath, ROOT } from './accounts';
import { Windows } from './badge';

/**
 * Codex accounts, and what each one has left.
 *
 * Each Codex login is a folder (CODEX_HOME) that Codex itself signed in to and keeps fresh: ~/.codex is the one the
 * Codex extension and the terminal use, and every folder Hire a Service added under ~/.hire/accounts/codex is one
 * more. Nothing here reads or writes a token. Usage comes from Codex's own app-server (`account/rateLimits/read`),
 * started with the account's folder, so Codex refreshes its own login the way it always does.
 *
 * It used to come from the last rate-limit snapshot in ~/.codex/sessions. That is only written while a request
 * succeeds, so an account that ran out kept showing its last good figure (36% left while it was out, 9 Nov 2026),
 * and HAS's accounts share that sessions folder, so snapshots from two accounts were mixed together.
 */

export interface CodexAccount {
  id: string;
  label: string;
  /** CODEX_HOME for this login. */
  home: string;
  /** True for ~/.codex: the login the Codex extension and terminal use. */
  mac: boolean;
  email?: string;
  plan?: string;
}

export interface CodexLimits extends Windows {
  /** Codex's own verdict: false means it will refuse work now, whatever the percentages say. */
  allowed?: boolean | null;
  /** Why, when it refuses: rate_limit_reached, workspace credits, and so on. */
  reached?: string | null;
  email?: string;
  plan?: string;
  error?: string;
  /** Not signed in, as opposed to a read that failed for a reason that passes. */
  signedOut?: boolean;
}

const MAC_HOME = join(homedir(), '.codex');
export const HAS_CODEX = join(homedir(), '.hire', 'accounts', 'codex');
const CACHE = join(ROOT, 'codex.json');

/** This Mac's login first, then each account HAS signed in, in slot order. */
export function codexAccounts(hasRoot = HAS_CODEX, macHome = MAC_HOME): CodexAccount[] {
  const list: CodexAccount[] = [{ id: 'mac', label: 'this Mac', home: macHome, mac: true }];
  let slots: string[] = [];
  try { slots = readdirSync(hasRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { /* HAS has none */ }
  slots.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const slot of slots) {
    const home = join(hasRoot, slot);
    if (existsSync(join(home, 'auth.json'))) list.push({ id: `has:${slot}`, label: slot.replace('_', ' '), home, mac: false });
  }
  return list;
}

/** Percent used and epoch seconds, as Codex reports them, to percent left and epoch ms. */
export function limitsFromCodex(r: {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: { primary?: CodexWindow | null; secondary?: CodexWindow | null; planType?: string | null; rateLimitReachedType?: string | null } | null;
}): CodexLimits {
  const s = r.rateLimits ?? {};
  const left = (w?: CodexWindow | null) => (typeof w?.usedPercent === 'number' ? Math.max(0, 100 - w.usedPercent) : undefined);
  const at = (w?: CodexWindow | null) => (typeof w?.resetsAt === 'number' ? w.resetsAt * 1000 : undefined);
  // Codex names its windows by length, not by position: take each by how long it is
  const windows = [s.primary, s.secondary].filter((w): w is CodexWindow => !!w);
  const five = windows.find(w => (w.windowDurationMins ?? 300) <= 300) ?? (windows.length === 2 ? s.primary : undefined);
  const week = windows.find(w => (w.windowDurationMins ?? 0) > 300) ?? (windows.length === 2 ? s.secondary : undefined);
  return {
    fiveHour: left(five), fiveHourResetsAt: at(five), sevenDay: left(week), sevenDayResetsAt: at(week),
    allowed: r.ordinaryUsageAllowed, reached: s.rateLimitReachedType ?? null, plan: s.planType ?? undefined
  };
}
interface CodexWindow { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null; }

/**
 * Ask Codex's app-server, for one account, who it is and what it has left. One short-lived process; about a
 * second for an account whose token is fresh, longer when Codex refreshes it first.
 */
export function readCodexLimits(home: string, command = 'codex', timeoutMs = 25_000): Promise<CodexLimits> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), CODEX_HOME: home };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, ['app-server'], { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { resolve({ error: `codex could not start: ${e instanceof Error ? e.message : e}` }); return; }
    let buf = '', email: string | undefined, plan: string | undefined, settled = false;
    const finish = (r: CodexLimits) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill();
      resolve({ ...r, email: r.email ?? email, plan: r.plan ?? plan });
    };
    const timer = setTimeout(() => finish({ error: 'codex did not answer in time' }), timeoutMs);
    const send = (m: unknown) => child.stdin?.write(JSON.stringify(m) + '\n');
    child.once('error', e => finish({ error: `codex could not start: ${e.message}` }));
    child.once('close', () => finish({ error: 'codex stopped before answering' }));
    child.stdout?.on('data', d => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: number; result?: any; error?: { message?: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: {} });
        } else if (m.id === 2) {
          const a = m.result?.account;
          if (!a) return finish({ signedOut: true, error: 'signed out' });
          if (a.type === 'chatgpt') { email = a.email ?? undefined; plan = a.planType ?? undefined; }
          send({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else if (m.id === 3) {
          if (m.error) return finish({ error: m.error.message ?? 'usage could not be read' });
          return finish(limitsFromCodex(m.result ?? {}));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'quota-relay', title: 'Quota Relay', version: '1' }, capabilities: null } });
  });
}

/** Can this account take work now? Codex's own word first; percentages only when it gave none. */
export function usable(l?: CodexLimits): boolean {
  if (!l || l.signedOut) return false;
  if (l.allowed === false) return false;
  if (l.allowed === true) return true;
  const both = [l.fiveHour, l.sevenDay].filter((n): n is number => typeof n === 'number');
  return !both.length || Math.min(...both) > 0;
}

/**
 * The account Codex work should go to: this Mac's login while it can run, otherwise the one with the most left
 * whose week resets soonest, the same order the Claude accounts are spent in.
 */
export function pickCodex(accounts: CodexAccount[], limits: Record<string, CodexLimits | undefined>): CodexAccount | undefined {
  const ok = accounts.filter(a => usable(limits[a.id]));
  const mac = ok.find(a => a.mac);
  if (mac) return mac;
  const tight = (a: CodexAccount) => Math.min(limits[a.id]?.fiveHour ?? 100, limits[a.id]?.sevenDay ?? 100);
  return ok.sort((a, b) => (tight(b) >= 50 ? 1 : 0) - (tight(a) >= 50 ? 1 : 0)
    || (limits[a.id]?.sevenDayResetsAt ?? Infinity) - (limits[b.id]?.sevenDayResetsAt ?? Infinity)
    || tight(b) - tight(a))[0] ?? accounts.find(a => !limits[a.id]);
}

export interface CodexReading { limits?: CodexLimits; at: number; triedAt?: number; fails?: number; }

export async function loadCodexReadings(): Promise<Record<string, CodexReading>> {
  try { return JSON.parse(await readFile(CACHE, 'utf8')); } catch { return {}; }
}

export async function saveCodexReadings(all: Record<string, CodexReading>): Promise<void> {
  const { writeFile, rename } = await import('node:fs/promises');
  await mkdir(ROOT, { recursive: true });
  const tmp = `${CACHE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(all));
  await rename(tmp, CACHE);
}

/** Codex accounts are read every five minutes, every fifteen when resting, backing off after failures. */
export function codexDue(r: CodexReading | undefined, inUse: boolean, now = Date.now()): boolean {
  if (!r) return true;
  if (r.fails) return now >= (r.triedAt ?? r.at) + Math.min(30, 2 ** r.fails) * 60_000;
  return now >= r.at + (inUse ? 5 : 15) * 60_000;
}
