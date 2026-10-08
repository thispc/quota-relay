import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Quota, parseClaudeUsageOutput, quotaFromUsage } from './quota';

/**
 * Two (or more) Claude subscriptions behind one ~/.claude.
 *
 * Every Claude client on this machine (terminal, the VS Code extension, our own workers) reads its login from one
 * place: the "home" slot, the Keychain item "Claude Code-credentials" plus `oauthAccount` in ~/.claude.json. Each
 * account here also has a profile folder, ~/.claude-accounts/<id>; with CLAUDE_CONFIG_DIR pointed at it Claude
 * keeps that login in its own Keychain item, named after a hash of the folder. That is where a browser login for
 * a new account lands, and where an account rests while another one is active.
 *
 * One rule keeps it sound: the active account's live login is in the home slot, every other account's is in its
 * own slot. Switching moves the outgoing one home → its slot, then the incoming one its slot → home. History,
 * settings, skills and MCP logins stay in ~/.claude and are shared, because only the Claude login moves.
 */

export interface Account {
  id: string;
  label: string;
  email?: string;
  plan?: string;
  /** The profile folder: CLAUDE_CONFIG_DIR for this account's own slot. */
  dir: string;
  /** Its login was refused or is missing: it needs a browser sign-in before it can be used. */
  needsLogin?: boolean;
}

export interface AccountsState {
  accounts: Account[];
  active?: string;
  /** When we last moved logins, to tell a stray token refresh from someone running /login. */
  switchedAt?: number;
  /** A fingerprint of the refresh token we left in the home slot, to notice when something else replaces it. */
  homeFp?: string;
}

export interface Creds {
  claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; subscriptionType?: string; [k: string]: unknown };
  organizationUuid?: string;
  [k: string]: unknown;
}

export const ROOT = join(homedir(), '.claude-accounts');
const STATE = join(ROOT, 'state.json');
const USAGE = join(ROOT, 'usage.json');
const LOCK = join(ROOT, '.lock');
const HOME_DIR = join(homedir(), '.claude');
const HOME_JSON = join(homedir(), '.claude.json');
const API = 'https://api.anthropic.com';

// ---------------------------------------------------------------------------------------------------------------
// Where Claude keeps a login
// ---------------------------------------------------------------------------------------------------------------

/** The Keychain item Claude Code uses for a config folder; `undefined` is the default ~/.claude. */
export function keychainService(dir?: string): string {
  return dir ? `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`
             : 'Claude Code-credentials';
}

/** The Keychain account Claude Code files its items under. */
function keychainAccount(): string {
  let u: string;
  try { u = process.env.USER || userInfo().username; } catch { u = 'claude-code-user'; }
  return /^[a-zA-Z0-9._-]+$/.test(u) ? u : 'claude-code-user';
}

const configJson = (dir?: string) => dir ? join(dir, '.claude.json') : HOME_JSON;

export function fingerprint(c?: Creds): string | undefined {
  const t = c?.claudeAiOauth?.refreshToken ?? c?.claudeAiOauth?.accessToken;
  return t ? createHash('sha256').update(t).digest('hex').slice(0, 12) : undefined;
}

export async function readCreds(dir?: string): Promise<Creds | undefined> {
  let raw: string | undefined;
  if (process.platform === 'darwin') {
    const r = await run('security', ['find-generic-password', '-a', keychainAccount(), '-s', keychainService(dir), '-w']);
    raw = r.code === 0 ? r.stdout.trim() : undefined;
  } else {
    raw = await readFile(join(dir ?? HOME_DIR, '.credentials.json'), 'utf8').catch(() => undefined);
  }
  if (!raw) return undefined;
  try { return JSON.parse(raw) as Creds; } catch { return undefined; }
}

export async function writeCreds(dir: string | undefined, creds: Creds): Promise<void> {
  const body = JSON.stringify(creds);
  if (process.platform === 'darwin') {
    // As hex, which needs no quoting. Through stdin when it fits, so the token is not in a process listing; but
    // `security -i` reads each line into a 4096-byte buffer and runs whatever fitted, so a longer line (the home
    // item also carries MCP logins) stored a cut-off item and signed Claude out (8 Oct 2026). Longer goes in argv.
    const hex = Buffer.from(body, 'utf8').toString('hex');
    const acct = keychainAccount(), svc = keychainService(dir);
    const line = `add-generic-password -U -a ${acct} -s "${svc}" -X ${hex}\n`;
    const r = line.length < 4000 ? await run('security', ['-i'], { input: line })
                                 : await run('security', ['add-generic-password', '-U', '-a', acct, '-s', svc, '-X', hex]);
    // never quote security's own output: it echoes the command, token and all
    if (r.code !== 0 || r.stderr.trim()) throw new Error(`Keychain write failed (security exited ${r.code})`);
    const back = await readCreds(dir);
    if (!back || JSON.stringify(back) !== body) throw new Error('Keychain write did not read back as written');
  } else {
    const file = join(dir ?? HOME_DIR, '.credentials.json');
    await mkdir(dir ?? HOME_DIR, { recursive: true });
    await writeAtomic(file, body, 0o600);
  }
}

async function readAccountInfo(dir?: string): Promise<Record<string, unknown> | undefined> {
  try { return (JSON.parse(await readFile(configJson(dir), 'utf8')) as { oauthAccount?: Record<string, unknown> }).oauthAccount; }
  catch { return undefined; }
}

/** Set `oauthAccount` and leave the rest of the file (projects, MCP servers, settings) as it was. */
async function writeAccountInfo(dir: string | undefined, info: Record<string, unknown>): Promise<void> {
  const file = configJson(dir);
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(await readFile(file, 'utf8')); } catch { /* a new profile folder has none yet */ }
  j.oauthAccount = info;
  await writeAtomic(file, JSON.stringify(j, null, 2));
}

// ---------------------------------------------------------------------------------------------------------------
// What an account has left
// ---------------------------------------------------------------------------------------------------------------

interface Profile { email?: string; plan?: string; }

async function api<T>(path: string, token: string): Promise<{ status: number; body?: T }> {
  const r = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000)
  });
  return { status: r.status, body: r.ok ? await r.json() as T : undefined };
}

export async function profileOf(token: string): Promise<Profile | undefined> {
  const r = await api<{ account?: { email?: string; has_claude_max?: boolean; has_claude_pro?: boolean } }>('/api/oauth/profile', token).catch(() => undefined);
  const a = r?.body?.account;
  return a ? { email: a.email, plan: a.has_claude_max ? 'max' : a.has_claude_pro ? 'pro' : undefined } : undefined;
}

/**
 * The account's windows. Read over HTTPS with the token it already has, which costs nothing and starts nothing;
 * only when that token has expired is Claude itself run (in an empty folder), because refreshing it is Claude's
 * job and doing it here would rotate the refresh token behind its back.
 */
export async function readAccountQuota(acc: Account, isActive: boolean, claudeCmd: string): Promise<Quota> {
  const dir = isActive ? undefined : acc.dir;
  const creds = await readCreds(dir);
  const o = creds?.claudeAiOauth;
  if (!o?.accessToken) return { error: 'signed out' };
  if ((o.expiresAt ?? 0) > Date.now() + 60_000) {
    const r = await api<{ five_hour?: unknown; seven_day?: unknown }>('/api/oauth/usage', o.accessToken).catch(() => undefined);
    if (r?.body) return quotaFromUsage(r.body as Parameters<typeof quotaFromUsage>[0]);
    if (r?.status === 429) return { error: 'usage endpoint is rate limiting; try again shortly' };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  if (dir) env.CLAUDE_CONFIG_DIR = dir; else delete env.CLAUDE_CONFIG_DIR;
  const r = await run(resolveClaude(claudeCmd), ['--tools', '', '-p', '/usage', '--output-format', 'json'],
                      { env, cwd: await emptyDir(), timeoutMs: 30_000 });
  if (/not logged in|invalid.*(token|credential)|please run \/login|authentication_error|401/i.test(r.stdout + r.stderr)) {
    return { error: 'signed out' };
  }
  const q = parseClaudeUsageOutput(r.stdout);
  return q.error ? { error: r.stderr.trim().split('\n').pop() || q.error } : q;
}

// ---------------------------------------------------------------------------------------------------------------
// Which account should be active
// ---------------------------------------------------------------------------------------------------------------

export interface Reading { quota?: Quota; at: number; }

export interface Policy {
  /** At or below this much of the tighter window left, move to another account. */
  switchBelow: number;
  /** Only move to an account with at least this much more than `switchBelow`, so it is worth the move. */
  margin: number;
}

export const DEFAULT_POLICY: Policy = { switchBelow: 5, margin: 10 };

const usable = (a: Account, r?: Reading) => !a.needsLogin && !r?.quota?.error;
const left = (r?: Reading) => r?.quota?.remaining;

/**
 * Drain one subscription, then the next.
 *
 * The active account is kept until its tighter window (5-hour or weekly) is nearly spent, so one subscription is
 * used up while the other's windows fill back up, and then they trade places. When choosing what to move to, an
 * account with plenty left whose weekly allowance resets soonest goes first: what it has left this week is lost
 * at the reset if it is not used, while the other one's carries on.
 */
export function chooseAccount(accounts: Account[], active: string | undefined, readings: Record<string, Reading | undefined>,
                              policy: Policy = DEFAULT_POLICY): { id?: string; switch: boolean; reason: string } {
  const cur = accounts.find(a => a.id === active);
  const curLeft = cur ? left(readings[cur.id]) : undefined;
  if (cur && usable(cur, readings[cur.id]) && (curLeft === undefined || curLeft > policy.switchBelow)) {
    return { id: cur.id, switch: false, reason: curLeft === undefined ? `${cur.label}: usage not read yet` : `${cur.label} has ${curLeft}% left` };
  }
  const others = accounts.filter(a => a.id !== active && usable(a, readings[a.id]));
  const known = others.filter(a => (left(readings[a.id]) ?? -1) > policy.switchBelow + policy.margin);
  const fresh = (a: Account) => (left(readings[a.id]) ?? 0) >= 50 ? 1 : 0;
  const weekReset = (a: Account) => readings[a.id]?.quota?.sevenDayResetsAt ?? Infinity;
  known.sort((a, b) => (fresh(b) - fresh(a)) || (weekReset(a) - weekReset(b)) || ((left(readings[b.id]) ?? 0) - (left(readings[a.id]) ?? 0)));
  // an account whose usage could not be read is still better than one known to be spent
  const pick = known[0] ?? (cur && usable(cur, readings[cur.id]) ? undefined : others.find(a => left(readings[a.id]) === undefined));
  const why = cur ? (usable(cur, readings[cur.id]) ? `${cur.label} is down to ${curLeft}%` : `${cur.label} is signed out`) : 'no account is active';
  if (pick) return { id: pick.id, switch: true, reason: `${why}; ${pick.label} has ${left(readings[pick.id]) ?? '?'}% left` };
  const back = Math.min(...accounts.map(a => readings[a.id]?.quota?.resetsAt ?? Infinity));
  return { id: cur?.id, switch: false,
           reason: `${why}, and no other account has room${Number.isFinite(back) ? `; first back at ${new Date(back).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` };
}

// ---------------------------------------------------------------------------------------------------------------
// The registry, shared by every VS Code window
// ---------------------------------------------------------------------------------------------------------------

export async function loadState(): Promise<AccountsState> {
  try { return JSON.parse(await readFile(STATE, 'utf8')) as AccountsState; } catch { return { accounts: [] }; }
}

export async function saveState(s: AccountsState): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await writeAtomic(STATE, JSON.stringify(s, null, 2));
}

/** Readings shared between windows, so four open windows do not each ask for the same numbers. */
export async function loadReadings(): Promise<Record<string, Reading>> {
  try { return JSON.parse(await readFile(USAGE, 'utf8')); } catch { return {}; }
}

export async function saveReading(id: string, r: Reading): Promise<void> {
  const all = await loadReadings();
  all[id] = r;
  await mkdir(ROOT, { recursive: true });
  await writeAtomic(USAGE, JSON.stringify(all));
}

/** One window at a time moves logins around. A lock older than a minute belongs to a window that died. */
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(ROOT, { recursive: true });
  for (let i = 0; ; i++) {
    try { await mkdir(LOCK); break; } catch {
      const age = await stat(LOCK).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age > 60_000) { await rm(LOCK, { recursive: true, force: true }); continue; }
      if (i > 50) throw new Error('another window is switching accounts; try again');
      await new Promise(r => setTimeout(r, 200));
    }
  }
  try { return await fn(); } finally { await rm(LOCK, { recursive: true, force: true }); }
}

export function slug(text: string, taken: string[]): string {
  const base = text.toLowerCase().replace(/@.*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The login already in ~/.claude becomes the first account, so nothing has to be signed into twice.
 * Returns the state unchanged when it already knows its accounts or there is no login to adopt.
 */
export async function adoptHome(s: AccountsState): Promise<AccountsState> {
  if (s.accounts.length) return s;
  const creds = await readCreds();
  if (!creds?.claudeAiOauth) return s;
  const info = await readAccountInfo();
  const email = typeof info?.emailAddress === 'string' ? info.emailAddress : undefined;
  const id = slug(email ?? 'main', []);
  const next: AccountsState = {
    accounts: [{ id, label: id, email, plan: creds.claudeAiOauth.subscriptionType, dir: join(ROOT, id) }],
    active: id, homeFp: fingerprint(creds)
  };
  await mkdir(join(ROOT, id), { recursive: true });
  await saveState(next);
  return next;
}

/** Make `to` the account every Claude client on this machine uses. */
export async function switchTo(toId: string): Promise<AccountsState> {
  return withLock(async () => {
    const s = await loadState();
    const to = s.accounts.find(a => a.id === toId);
    if (!to) throw new Error(`no account "${toId}"`);
    if (s.active === toId) return s;
    const incoming = await readCreds(to.dir);
    if (!incoming?.claudeAiOauth?.accessToken) {
      to.needsLogin = true; await saveState(s);
      throw new Error(`${to.label} is not signed in; sign it in first`);
    }
    const incomingInfo = await readAccountInfo(to.dir);
    const home = await readCreds();
    const from = s.accounts.find(a => a.id === s.active);
    if (from && home?.claudeAiOauth) {
      // park the outgoing login first: if anything after this fails, home still holds it and nothing is lost
      await mkdir(from.dir, { recursive: true });
      await writeCreds(from.dir, { claudeAiOauth: home.claudeAiOauth, organizationUuid: home.organizationUuid });
      const info = await readAccountInfo();
      if (info) await writeAccountInfo(from.dir, info);
    }
    // only the Claude login moves; anything else in the home item (MCP server logins) stays where it is
    try {
      await writeCreds(undefined, { ...(home ?? {}), claudeAiOauth: incoming.claudeAiOauth, organizationUuid: incoming.organizationUuid });
    } catch (e) {
      // put back exactly what was there, so a failed switch leaves Claude signed in as before
      if (home) await writeCreds(undefined, home).catch(() => undefined);
      throw e;
    }
    if (incomingInfo) await writeAccountInfo(undefined, incomingInfo);
    s.active = toId; s.switchedAt = Date.now(); s.homeFp = fingerprint(incoming);
    await saveState(s);
    return s;
  });
}

/**
 * Something other than us changed the home login: Claude refreshed the token, or someone ran /login.
 *
 * A refresh keeps the owner, so nothing to do. A different owner moments after we switched is a session that was
 * mid-refresh with the old account's token; that login is parked in its own slot and ours is put back. A different
 * owner any other time is someone's deliberate choice, and the registry follows it.
 */
export async function reconcileHome(): Promise<{ state: AccountsState; note?: string }> {
  return withLock(async () => {
    const s = await loadState();
    const home = await readCreds();
    const fp = fingerprint(home);
    if (!fp || fp === s.homeFp) return { state: s };
    const token = home?.claudeAiOauth?.accessToken;
    const owner = token ? await profileOf(token) : undefined;
    if (!owner?.email) return { state: s };             // cannot tell (offline, expired): look again next time
    const active = s.accounts.find(a => a.id === s.active);
    if (!active || owner.email === active.email) { s.homeFp = fp; await saveState(s); return { state: s }; }
    const known = s.accounts.find(a => a.email === owner.email);
    if (known && s.switchedAt && Date.now() - s.switchedAt < 2 * 60_000) {
      await writeCreds(known.dir, { claudeAiOauth: home!.claudeAiOauth, organizationUuid: home!.organizationUuid });
      const ours = await readCreds(active.dir);
      if (ours?.claudeAiOauth) {
        await writeCreds(undefined, { ...home, claudeAiOauth: ours.claudeAiOauth, organizationUuid: ours.organizationUuid });
        s.homeFp = fingerprint(ours); await saveState(s);
        return { state: s, note: `A ${known.label} session refreshed its login just after the switch; ${active.label} is put back.` };
      }
    }
    if (known) {
      s.active = known.id; s.homeFp = fp; known.needsLogin = false;
      // the outgoing account's login was overwritten in place; its parked copy may still work
      await saveState(s);
      return { state: s, note: `Claude was signed in to ${known.label} outside the switcher; following it.` };
    }
    s.homeFp = fp; await saveState(s);
    return { state: s, note: `Claude is now signed in as ${owner.email}, which is not one of your accounts. Add it to switch to it.` };
  });
}

/** Wait for a browser login into `dir` to land, by watching its slot. */
export async function waitForLogin(dir: string | undefined, before: string | undefined, isDone: () => boolean,
                                   timeoutMs = 10 * 60_000): Promise<Creds | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const c = await readCreds(dir);
    const fp = fingerprint(c);
    if (fp && fp !== before) return c;
    // the login process has exited: one last look, then give up
    if (isDone()) { await new Promise(r => setTimeout(r, 1500)); const last = await readCreds(dir); return fingerprint(last) !== before ? last : undefined; }
    await new Promise(r => setTimeout(r, 1500));
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Process and file helpers
// ---------------------------------------------------------------------------------------------------------------

export function resolveClaude(cmd: string): string {
  if (cmd.includes('/')) return cmd;
  for (const c of [join(homedir(), '.local', 'bin', cmd), `/opt/homebrew/bin/${cmd}`, `/usr/local/bin/${cmd}`]) {
    if (existsSync(c)) return c;
  }
  return cmd;
}

/** VS Code started from the Dock has a bare PATH; Claude and its helpers live in the usual user folders. */
export function augmentedPath(): string {
  const extra = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(p => existsSync(p));
  return [...extra, process.env.PATH ?? ''].join(':');
}

async function emptyDir(): Promise<string> {
  // started from VS Code's cwd (/), Claude indexed every file on the disk (29 Sep 2026)
  const dir = join(tmpdir(), 'quota-relay-empty');
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return dir;
}

async function writeAtomic(file: string, body: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, body, mode ? { mode } : undefined);
  await rename(tmp, file);
}

function run(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {})
  : Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 15_000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(opts.input ?? '');
  });
}
