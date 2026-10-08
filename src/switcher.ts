import * as vscode from 'vscode';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Account, AccountsState, Policy, Reading, ROOT, adoptHome, augmentedPath, chooseAccount, fingerprint, loadReadings,
  loadState, profileOf, readAccountQuota, readCreds, reconcileHome, resolveClaude, saveReading, saveState, slug,
  switchTo, waitForLogin
} from './accounts';
import { Quota } from './quota';

/**
 * The Claude accounts, as VS Code sees them: one status bar item, one menu, and a loop that keeps the active
 * account the one with room.
 */
export class Switcher implements vscode.Disposable {
  private state: AccountsState = { accounts: [] };
  private readings: Record<string, Reading> = {};
  private readonly item: vscode.StatusBarItem;
  private timer?: ReturnType<typeof setInterval>;
  private busy?: Promise<void>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly out: vscode.OutputChannel, private readonly claudeCmd: () => string) {
    this.item = vscode.window.createStatusBarItem('quotaRelay.claudeAccount', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Claude Account';
    this.item.command = 'quotaRelay.accounts';
    this.item.show();
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.item.dispose(); this.changed.dispose(); }

  async start(): Promise<void> {
    this.state = await adoptHome(await loadState());
    this.readings = await loadReadings();
    this.paint();
    void this.tick();
    // every two minutes; the readings themselves are reused for longer (see `stale`), across windows too
    this.timer = setInterval(() => void this.tick(), 120_000);
  }

  get active(): Account | undefined { return this.state.accounts.find(a => a.id === this.state.active); }

  /** The active account's windows, for the status bar and the model ladder. */
  activeQuota(): Quota | undefined { return this.active ? this.readings[this.active.id]?.quota : undefined; }

  /**
   * How much Claude there is to spend: the most any signed-in account has. With a second subscription full,
   * the first running low is not a reason to step down to a smaller model or hand work to Codex.
   */
  poolQuota(): Quota | undefined {
    const qs = this.state.accounts.filter(a => !a.needsLogin).map(a => this.readings[a.id]?.quota)
      .filter((q): q is Quota => typeof q?.remaining === 'number');
    return qs.sort((a, b) => b.remaining! - a.remaining!)[0] ?? this.activeQuota();
  }

  private policy(): Policy {
    const c = vscode.workspace.getConfiguration('quotaRelay.accounts');
    return { switchBelow: c.get<number>('switchBelowPercent', 5), margin: c.get<number>('switchMargin', 10) };
  }
  private auto(): boolean { return vscode.workspace.getConfiguration('quotaRelay.accounts').get<boolean>('autoSwitch', true); }

  /** The active account is read every few minutes; resting ones change only by refilling, so less often. */
  private stale(a: Account): boolean {
    const r = this.readings[a.id];
    const ttl = a.id === this.state.active ? 3 * 60_000 : 10 * 60_000;
    return !r || Date.now() - r.at > (r.quota?.error ? 60_000 : ttl);
  }

  /** One pass: notice outside changes, refresh what is stale, and move if the active account is spent. */
  tick(force = false): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      try {
        const rec = await reconcileHome().catch(e => { this.log(`reconcile: ${e}`); return undefined; });
        if (rec) { this.state = rec.state; if (rec.note) this.tell(rec.note); }
        this.readings = { ...this.readings, ...(await loadReadings()) };   // another window may have read already
        await Promise.all(this.state.accounts.filter(a => force || this.stale(a)).map(a => this.read(a)));
        this.paint();
        if (this.auto()) await this.autoSwitch();
      } finally { this.busy = undefined; this.paint(); this.changed.fire(); }
    })();
    return this.busy;
  }

  private async read(a: Account): Promise<void> {
    const quota = await readAccountQuota(a, a.id === this.state.active, this.claudeCmd())
      .catch(e => ({ error: String(e instanceof Error ? e.message : e) }) as Quota);
    const r = { quota, at: Date.now() };
    this.readings[a.id] = r;
    await saveReading(a.id, r).catch(() => undefined);
    const signedOut = quota.error === 'signed out';
    if (signedOut !== !!a.needsLogin) {
      a.needsLogin = signedOut;
      const s = await loadState();
      const same = s.accounts.find(x => x.id === a.id);
      if (same) { same.needsLogin = signedOut; await saveState(s); }
    }
  }

  private async autoSwitch(): Promise<void> {
    if (this.state.accounts.length < 2) return;
    const pick = chooseAccount(this.state.accounts, this.state.active, this.readings, this.policy());
    if (!pick.switch || !pick.id) return;
    // one move per few minutes at most, unless the account we are on cannot be used at all
    const recent = this.state.switchedAt && Date.now() - this.state.switchedAt < 5 * 60_000;
    if (recent && this.active && !this.active.needsLogin && (this.activeQuota()?.remaining ?? 1) > 0) return;
    await this.switch(pick.id, pick.reason);
  }

  /** The worker manager's hook: Claude just said the window is spent. */
  async onSpent(): Promise<boolean> {
    if (this.state.accounts.length < 2) return false;
    const cur = this.active;
    if (cur) this.readings[cur.id] = { quota: { ...(this.readings[cur.id]?.quota ?? {}), remaining: 0, error: undefined }, at: Date.now() };
    const pick = chooseAccount(this.state.accounts, this.state.active, this.readings, this.policy());
    if (!pick.switch || !pick.id) return false;
    return this.switch(pick.id, `${cur?.label ?? 'Claude'} hit its limit mid-task`).then(() => true, () => false);
  }

  async switch(id: string, why?: string): Promise<void> {
    const from = this.active?.label;
    try {
      this.state = await switchTo(id);
    } catch (e) {
      this.tell(`Could not switch Claude account: ${e instanceof Error ? e.message : e}`, 'error');
      throw e;
    }
    const to = this.active!;
    this.tell(`Claude is now on ${to.label}${to.email ? ` (${to.email})` : ''}${from ? `, moved from ${from}` : ''}.${why ? ` ${why}.` : ''} Running sessions follow within about 30 seconds.`);
    this.paint(); this.changed.fire();
    void this.tick(true);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Signing in through the browser
  // -------------------------------------------------------------------------------------------------------------

  async addAccount(): Promise<void> {
    const label = await vscode.window.showInputBox({ title: 'Add a Claude account', prompt: 'A short name for it',
      placeHolder: 'work, personal, max…', validateInput: v => v.trim() ? undefined : 'Give it a name' });
    if (!label) return;
    const email = await vscode.window.showInputBox({ title: 'Add a Claude account',
      prompt: 'Its email, to fill in on the login page (optional)', placeHolder: 'you@example.com' });
    const s = await loadState();
    const id = slug(label, s.accounts.map(a => a.id));
    const dir = join(ROOT, id);
    await mkdir(dir, { recursive: true });
    const creds = await this.browserLogin(dir, label, email?.trim() || undefined);
    if (!creds) { await rm(dir, { recursive: true, force: true }); return; }
    const who = creds.claudeAiOauth?.accessToken ? await profileOf(creds.claudeAiOauth.accessToken) : undefined;
    const fresh = await loadState();
    const dup = fresh.accounts.find(a => a.email && a.email === who?.email);
    if (dup) {
      this.tell(`That login is ${who!.email}, which is already "${dup.label}". Sign in with your other Claude account to add it.`, 'warn');
      await rm(dir, { recursive: true, force: true });
      return;
    }
    fresh.accounts.push({ id, label: label.trim(), email: who?.email, plan: who?.plan ?? creds.claudeAiOauth?.subscriptionType, dir });
    await saveState(fresh);
    this.state = fresh;
    this.tell(`Added ${label.trim()}${who?.email ? ` (${who.email})` : ''}. It takes over when ${this.active?.label ?? 'the current account'} runs low.`);
    void this.tick(true);
  }

  /** Sign an account in again: the active one in place, a resting one in its own folder. */
  async relogin(a: Account): Promise<void> {
    const isActive = a.id === this.state.active;
    const creds = await this.browserLogin(isActive ? undefined : a.dir, a.label, a.email);
    if (!creds) return;
    const who = creds.claudeAiOauth?.accessToken ? await profileOf(creds.claudeAiOauth.accessToken) : undefined;
    if (a.email && who?.email && who.email !== a.email) {
      this.tell(`That was ${who.email}, not ${a.email}. Sign in to ${a.label} with ${a.email}.`, 'warn');
    }
    const s = await loadState();
    const same = s.accounts.find(x => x.id === a.id);
    if (same) {
      same.needsLogin = false; same.plan = who?.plan ?? same.plan;
      if (isActive) s.homeFp = fingerprint(creds);
      await saveState(s); this.state = s;
    }
    void this.tick(true);
  }

  /**
   * `claude auth login` in a terminal of its own: it opens the browser, and the terminal is there for the link
   * when the browser does not open. Claude is the terminal's process, so nothing passes through a shell.
   */
  private async browserLogin(dir: string | undefined, label: string, email?: string) {
    const before = fingerprint(await readCreds(dir));
    const env: Record<string, string | null> = { PATH: augmentedPath(), CLAUDE_CONFIG_DIR: dir ?? null };
    const term = vscode.window.createTerminal({
      name: `Claude login: ${label}`, iconPath: new vscode.ThemeIcon('account'), env,
      shellPath: resolveClaude(this.claudeCmd()), shellArgs: ['auth', 'login', ...(email ? ['--email', email] : [])]
    });
    term.show();
    let closed = false;
    const sub = vscode.window.onDidCloseTerminal(t => { if (t === term) closed = true; });
    try {
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, cancellable: true,
        title: `Signing in ${label}: finish in the browser window that opened`
      }, async (_p, cancel) => {
        const creds = await waitForLogin(dir, before, () => closed || cancel.isCancellationRequested);
        if (!creds) this.tell(`No login arrived for ${label}.`, 'warn');
        return creds;
      });
    } finally {
      sub.dispose();
      setTimeout(() => term.dispose(), 3000);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The menu
  // -------------------------------------------------------------------------------------------------------------

  async menu(): Promise<void> {
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const auto = this.auto();
    const items: Item[] = [{ label: 'Claude accounts', kind: vscode.QuickPickItemKind.Separator }];
    for (const a of this.state.accounts) {
      const q = this.readings[a.id]?.quota;
      const on = a.id === this.state.active;
      items.push({
        label: `${on ? '$(pass-filled)' : '$(circle-large-outline)'} ${a.label}`,
        description: [a.email, a.plan].filter(Boolean).join(' · '),
        detail: a.needsLogin ? '$(warning) Signed out: pick to sign in through the browser' : windows(q),
        run: a.needsLogin ? () => this.relogin(a) : on ? undefined : () => this.switch(a.id, 'Switched by hand')
      });
    }
    if (this.state.accounts.length) {
      const pick = chooseAccount(this.state.accounts, this.state.active, this.readings, this.policy());
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: `$(${auto ? 'sync' : 'circle-slash'}) Auto-switch: ${auto ? 'on' : 'off'}`,
          description: pick.reason,
          detail: `Moves to the next account when the active one is under ${this.policy().switchBelow}% of its tighter window`,
          run: () => vscode.workspace.getConfiguration('quotaRelay.accounts').update('autoSwitch', !auto, vscode.ConfigurationTarget.Global) });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Add a Claude account…', description: 'Sign in through the browser', run: () => this.addAccount() },
      { label: '$(refresh) Refresh usage', run: () => this.tick(true) });
    if (this.state.accounts.length) {
      items.push({ label: '$(sign-in) Sign an account in again…', run: async () => { const a = await this.pickAccount('Sign in again'); if (a) await this.relogin(a); } },
                 { label: '$(edit) Rename an account…', run: () => this.rename() },
                 { label: '$(trash) Remove an account…', run: () => this.remove() });
    }
    const chosen = await vscode.window.showQuickPick(items, { title: 'Claude accounts', placeHolder: 'Switch, add, or sign in' });
    await chosen?.run?.();
  }

  /** Next account in the list, for a keybinding. */
  async next(): Promise<void> {
    const list = this.state.accounts.filter(a => !a.needsLogin);
    if (list.length < 2) { void this.addAccount(); return; }
    const i = list.findIndex(a => a.id === this.state.active);
    await this.switch(list[(i + 1) % list.length].id, 'Switched by hand');
  }

  private async pickAccount(title: string): Promise<Account | undefined> {
    const p = await vscode.window.showQuickPick(this.state.accounts.map(a => ({ label: a.label, description: a.email, a })), { title });
    return p?.a;
  }

  private async rename(): Promise<void> {
    const a = await this.pickAccount('Rename which account?');
    if (!a) return;
    const label = await vscode.window.showInputBox({ value: a.label, prompt: 'New name' });
    if (!label?.trim()) return;
    const s = await loadState();
    const same = s.accounts.find(x => x.id === a.id);
    if (same) { same.label = label.trim(); await saveState(s); this.state = s; this.paint(); }
  }

  private async remove(): Promise<void> {
    const a = await this.pickAccount('Remove which account?');
    if (!a) return;
    if (a.id === this.state.active) {
      this.tell('Switch to another account before removing the active one; its login is the one Claude is using.', 'warn');
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Forget ${a.label}? Its login stays in the Keychain until you sign it out.`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    const s = await loadState();
    s.accounts = s.accounts.filter(x => x.id !== a.id);
    await saveState(s); this.state = s; this.paint();
  }

  // -------------------------------------------------------------------------------------------------------------

  private paint(): void {
    const a = this.active;
    if (!a) {
      this.item.text = '$(account) Claude: add account';
      this.item.tooltip = 'No Claude login found. Click to sign in through the browser.';
      this.item.color = undefined;
      return;
    }
    const q = this.readings[a.id]?.quota;
    const pct = q?.remaining;
    const several = this.state.accounts.length > 1;
    this.item.text = `$(account) ${several ? a.label : 'Claude'} ${a.needsLogin ? 'signed out' : pct === undefined ? '…' : `${pct}%`}${several && this.auto() ? ' $(sync)' : ''}`;
    this.item.color = a.needsLogin || (pct ?? 100) <= 15 ? new vscode.ThemeColor('charts.red')
                    : (pct ?? 100) <= 30 ? new vscode.ThemeColor('charts.yellow') : undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown('**Claude accounts**\n\n| | Account | 5-hour | Week |\n|:-:|:--|--:|--:|\n');
    for (const x of this.state.accounts) {
      const r = this.readings[x.id]?.quota;
      const cell = (v?: number, at?: number) => v === undefined ? '—' : `${v}%${at ? ` · ${until(at)}` : ''}`;
      md.appendMarkdown(`| ${x.id === a.id ? '●' : ''} | ${x.label}${x.plan ? ` (${x.plan})` : ''} | ${x.needsLogin ? 'signed out' : cell(r?.fiveHour, r?.fiveHourResetsAt)} | ${x.needsLogin ? '' : cell(r?.sevenDay, r?.sevenDayResetsAt)} |\n`);
    }
    if (several) md.appendMarkdown(`\n${chooseAccount(this.state.accounts, this.state.active, this.readings, this.policy()).reason}. Auto-switch is ${this.auto() ? 'on' : 'off'}.\n`);
    md.appendMarkdown('\n_Click to switch or add an account._');
    this.item.tooltip = md;
  }

  private log(line: string): void { this.out.appendLine(`[accounts] ${line}`); }
  private tell(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.log(text);
    if (level === 'error') void vscode.window.showErrorMessage(text);
    else if (level === 'warn') void vscode.window.showWarningMessage(text);
    else void vscode.window.showInformationMessage(text);
  }
}

function until(at: number): string {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.round(m / 1440)}d`;
}

function windows(q?: Quota): string {
  if (!q) return 'Usage not read yet';
  if (q.error) return `$(warning) ${q.error}`;
  const part = (name: string, v?: number, at?: number) => v === undefined ? undefined : `${name} ${v}% left${at ? ` (resets in ${until(at)})` : ''}`;
  return [part('5-hour', q.fiveHour, q.fiveHourResetsAt), part('week', q.sevenDay, q.sevenDayResetsAt)].filter(Boolean).join(' · ');
}
