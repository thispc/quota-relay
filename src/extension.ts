import * as vscode from 'vscode';
import { readConfig, WorkerConfig } from './config';
import { createAdapters } from './adapters';
import { say, newConversation } from './chat';
import { ChatPanel } from './panel';
import { readQuota, planFor } from './quota';
import { Switcher } from './switcher';
import { Level, Windows, levelOf, spareNote, tooltipTable, until, windowsText } from './badge';
import { readCodexUsage, CodexUsage } from './codex-usage';
import { readAntigravityUsage, AntigravityUsage, resetAntigravityCache } from './antigravity-usage';
import { Conversation, WorkerAdapter, WorkerId, AgentTask, WorkerSelection } from './models';
import { WorkerManager } from './manager';

let manager: WorkerManager;
let switcher: Switcher;
let codexUsageStatus: vscode.StatusBarItem;
let antigravityUsageStatus: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let adapters: Record<WorkerId, WorkerAdapter>;
let contextState: vscode.Memento;
let extensionContext: vscode.ExtensionContext;
const terminals = new Map<WorkerId, vscode.Terminal>();
const historyKey = 'taskHistory';
const tasksKey = 'agentTasks';
const convKey = 'localCliWorkers.conversation';
let taskTree: TaskTreeProvider;

class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: AgentTask) {
    super(task.prompt.slice(0, 70), task.status === 'running' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${task.status} · ${task.worker}`;
    this.contextValue = task.status === 'running' ? 'runningTask' : 'task';
    this.iconPath = new vscode.ThemeIcon(
      task.status === 'completed' ? 'pass' :
      task.status === 'failed' ? 'error' :
      task.status === 'cancelled' ? 'circle-slash' :
      task.status === 'running' ? 'loading~spin' : 'circle-large-outline'
    );
    this.command = { command: 'quotaRelay.resumeTask', title: 'Resume Task', arguments: [task] };
  }
}

class TaskTreeProvider implements vscode.TreeDataProvider<TaskItem> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  constructor(private readonly getTasks: () => AgentTask[]) {}
  refresh(): void { this.change.fire(); }
  getTreeItem(item: TaskItem): vscode.TreeItem { return item; }
  getChildren(): TaskItem[] { return this.getTasks().slice().sort((a, b) => b.updatedAt - a.updatedAt).map(t => new TaskItem(t)); }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const config = readConfig();
  adapters = createAdapters(config.commands, config.codexSandbox, config.modelIds);
  manager = new WorkerManager(adapters, config.maxConcurrentTasks, config.failureThreshold, config.usageThreshold, config.limitedCooldownMs);
  contextState = context.workspaceState;
  taskTree = new TaskTreeProvider(() => contextState.get<AgentTask[]>(tasksKey, []));
  output = vscode.window.createOutputChannel('Quota Relay');
  switcher = new Switcher(output, () => readConfig().commands.claude);
  context.subscriptions.push(switcher, switcher.onDidChange(() => paintStatus()));
  manager.quotaPlan = () => {
    const cfg = readConfig();
    if (!cfg.powerSaver) return undefined;
    // across every signed-in account: the second subscription being full means there is no reason to save
    return planFor(switcher.poolQuota() ?? readQuota(), cfg.thresholds);
  };
  manager.onSpent = async worker => worker === 'claude' && switcher.onSpent();
  void switcher.start();

  manager.events.on('limited', ({ worker, until, next, reason }: { worker: string; until: number; next?: string; reason?: string }) => {
    const back = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const models = readConfig().modelIds as Record<string, string | undefined>;
    const to = next ? `${next}${models[next] ? ` (${models[next]})` : ''}` : 'nothing left';
    const line = next
      ? `${worker} is out of limit until ${back}. Switching to ${to}.`
      : `${worker} is out of limit until ${back}, and no other worker is free.`;
    output.appendLine(`\n>> ${line}${reason ? `\n   ${worker} said: ${reason}` : ''}`);
    vscode.window.showWarningMessage(line);
  });

  // Claude is the switcher's item; the other providers each get a badge
  codexUsageStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  codexUsageStatus.name = 'Codex Quota';
  codexUsageStatus.command = 'quotaRelay.refreshCodex';

  antigravityUsageStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  antigravityUsageStatus.name = 'Antigravity Quota';
  antigravityUsageStatus.command = 'quotaRelay.refreshAntigravity';

  codexUsageStatus.show();
  antigravityUsageStatus.show();

  paintStatus();

  // Refresh periodically in background
  const statusTimer = setInterval(() => {
    paintStatus();
  }, 60_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(statusTimer)));

  context.subscriptions.push(codexUsageStatus, antigravityUsageStatus, output);

  registerCommand(context, 'showQuota', (provider?: 'claude' | 'codex' | 'antigravity' | 'gemini') => {
    return showQuotaQuickPick(provider);
  });
  registerCommand(context, 'refreshClaude', () => refreshClaudeUsage());
  for (const [id, fn] of [['accounts', () => switcher.menu()], ['addAccount', () => switcher.addAccount()],
                          ['nextAccount', () => switcher.next()]] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(`quotaRelay.${id}`, fn));
  }
  registerCommand(context, 'refreshCodex', () => refreshCodexUsage());
  registerCommand(context, 'refreshAntigravity', () => refreshAntigravityUsage());
  registerCommand(context, 'refreshAll', () => refreshAllUsage());
  registerCommand(context, 'chat', () => {
    ChatPanel.show(context, manager, readConfig().modelIds as Record<string, string | undefined>, readConfig().taskTimeoutMs);
  });
  registerCommand(context, 'chatInput', chat);
  registerCommand(context, 'newChat', newChat);
  registerCommand(context, 'runTask', runTask);
  registerCommand(context, 'cancelTask', () => manager.cancelActive());
  registerCommand(context, 'showWorkers', showWorkers);
  registerCommand(context, 'checkAuth', checkAuth);
  registerCommand(context, 'openWorkerTerminal', openWorkerTerminal);
  registerCommand(context, 'resumeTask', (task: AgentTask) => runTask(task));
  registerCommand(context, 'clearHistory', async () => {
    await contextState.update(tasksKey, []);
    taskTree.refresh();
  });

  context.subscriptions.push(vscode.window.registerTreeDataProvider('quotaRelay.tasks', taskTree));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (['quotaRelay', 'aiSwitchboard', 'localCliWorkers'].some(n => e.affectsConfiguration(n))) {
      paintStatus();
    }
  }));
}

function registerCommand(context: vscode.ExtensionContext, id: string, callback: (...args: any[]) => any): void {
  context.subscriptions.push(vscode.commands.registerCommand(`quotaRelay.${id}`, callback));
}

// ---------------------------------------------------------------------------
// STATUS BAR PRESENTATION & FORMATTING (Concise, Clean & Non-blocking)
// ---------------------------------------------------------------------------

const LEVEL_COLOR: Record<Level, vscode.ThemeColor | undefined> = {
  spare: new vscode.ThemeColor('charts.blue'), ok: new vscode.ThemeColor('charts.green'), unknown: new vscode.ThemeColor('disabledForeground'),
  low: new vscode.ThemeColor('charts.yellow'), critical: new vscode.ThemeColor('charts.red')
};

/** Paint one provider's badge: the same `Name 5h N% · 7d N%` for all of them. */
function paintBadge(item: vscode.StatusBarItem, icon: string, name: string, w: Windows | undefined,
                    opts: { error?: string; notes?: string[] } = {}): void {
  const known = levelOf(w) !== 'unknown';
  item.text = `$(${icon}) ${name} ${windowsText(w)}`;
  item.color = LEVEL_COLOR[levelOf(w)];
  const md = new vscode.MarkdownString(tooltipTable(name, [{ name, windows: w, note: known ? undefined : `⚠ ${opts.error ?? 'usage not available'}` }],
    [...(spareNote(w) ? [spareNote(w)!] : []), ...(opts.notes ?? []), '_Click to refresh._']));
  md.supportHtml = true;
  item.tooltip = md;
}

function codexWindows(codex: CodexUsage): Windows {
  const left = (used?: number) => (used === undefined ? undefined : 100 - used);
  return { fiveHour: left(codex.primary?.usedPercent), fiveHourResetsAt: codex.primary?.resetsAt,
           sevenDay: left(codex.secondary?.usedPercent), sevenDayResetsAt: codex.secondary?.resetsAt };
}

/**
 * Antigravity's Gemini allowance only. Its Claude/GPT allowance runs out within minutes of use and stays out, so
 * a second pair of numbers that reads 0% most of the day only took the space (Pulkit, 11 Oct 2026). It is still
 * in the tooltip for when it matters.
 */
function geminiWindows(agy: AntigravityUsage): Windows {
  const five = agy.gemini?.fiveHour ?? agy.primary, week = agy.gemini?.weekly ?? agy.groups?.[0]?.weekly;
  return { fiveHour: five?.remainingPercent, fiveHourResetsAt: five?.resetsAt,
           sevenDay: week?.remainingPercent, sevenDayResetsAt: week?.resetsAt };
}

function paintStatus(): void {
  if (!codexUsageStatus || !antigravityUsageStatus) return;
  const cfg = readConfig();
  const codex = readCodexUsage();
  const agy = readAntigravityUsage({ command: cfg.antigravityCommand });

  const codexNotes = codex.requests > 0 || codex.totalTokens > 0
    ? [`${codex.requests} requests · ${(codex.totalTokens / 1_000_000).toFixed(1)}M tokens${codex.lastModel ? ` · ${codex.lastModel}` : ''}`] : [];
  paintBadge(codexUsageStatus, 'terminal', 'Codex', codexWindows(codex), { error: codex.error, notes: codexNotes });

  const third = agy.claudeGpt?.fiveHour;
  const agyNotes = [
    ...(third ? [`Claude & GPT models: ${Math.round(third.remainingPercent)}% of 5-hour left${third.resetsAt ? `, back in ${until(third.resetsAt)}` : ''}`] : []),
    ...(agy.conversationsCount !== undefined ? [`${agy.conversationsCount} conversations · ${agy.totalSteps ?? 0} steps`] : [])
  ];
  paintBadge(antigravityUsageStatus, 'sparkle', cfg.antigravityLabel || 'AGY', geminiWindows(agy),
             { error: agy.error, notes: ['Gemini models (Flash, Pro)', ...agyNotes] });
}

async function refreshClaudeUsage(showFeedback = true): Promise<void> {
  await switcher.tick(true);
  const q = switcher.activeQuota();
  if (showFeedback && q && !q.error) {
    vscode.window.setStatusBarMessage(`$(check) ${switcher.active?.label ?? 'Claude'} ${windowsText(q)}`, 5000);
  }
}

async function refreshCodexUsage(showFeedback = true): Promise<void> {
  const codex = readCodexUsage();
  paintStatus();
  if (showFeedback) vscode.window.setStatusBarMessage(`$(check) Codex ${windowsText(codexWindows(codex))}`, 5000);
}

async function refreshAntigravityUsage(showFeedback = true): Promise<void> {
  const cfg = readConfig();
  resetAntigravityCache();
  const agy = readAntigravityUsage({ command: cfg.antigravityCommand, forceRefresh: true });
  paintStatus();
  if (showFeedback) vscode.window.setStatusBarMessage(`$(check) ${cfg.antigravityLabel || 'AGY'} ${windowsText(geminiWindows(agy))}`, 5000);
}

async function refreshAllUsage(): Promise<void> {
  vscode.window.setStatusBarMessage('$(sync~spin) Refreshing all AI model quotas...', 3000);
  await Promise.all([
    refreshClaudeUsage(false),
    refreshCodexUsage(false),
    refreshAntigravityUsage(false)
  ]);
  vscode.window.setStatusBarMessage('$(check) All AI model quotas refreshed', 4000);
}

// ---------------------------------------------------------------------------
// INTERACTIVE QUICKPICK MODAL
// ---------------------------------------------------------------------------

/** When the tighter of the two windows comes back, for the line under a provider's name. */
function nextReset(w: Windows): string | undefined {
  const five = w.fiveHour ?? 101, week = w.sevenDay ?? 101;
  const at = five <= week ? w.fiveHourResetsAt : w.sevenDayResetsAt;
  return at && at > Date.now() ? `${five <= week ? '5h' : '7d'} back in ${until(at)}` : undefined;
}

async function showQuotaQuickPick(provider?: 'claude' | 'codex' | 'antigravity' | 'gemini'): Promise<void> {
  const cfg = readConfig();
  const q = switcher.activeQuota() ?? readQuota();
  const codex = readCodexUsage();
  const agy = readAntigravityUsage({ command: cfg.antigravityCommand, forceRefresh: true });

  const codexW = codexWindows(codex), geminiW = geminiWindows(agy);
  const pool = switcher.poolQuota();

  const plan = manager?.quotaPlan?.() ?? { worker: cfg.defaultWorker === 'auto' ? 'claude' : cfg.defaultWorker, model: cfg.modelIds.claude ?? 'sonnet' };

  interface ActionItem extends vscode.QuickPickItem {
    action?: () => void | Promise<void>;
  }

  const items: ActionItem[] = [
    {
      label: 'ACTIVE ROUTING',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: `$(zap) Target Worker: ${plan.worker.toUpperCase()} (${plan.model ?? 'default'})`,
      description: cfg.powerSaver ? `PowerSaver Active · Ladder: ${plan.model ?? 'sonnet'}` : 'Manual / Standard Routing',
      detail: typeof pool?.remaining === 'number'
        ? `Most any Claude account has left: ${pool.remaining}%. At ${cfg.thresholds.saverBelow}% or less, work goes to Codex.`
        : 'Dynamic worker selection based on task and capacity.',
    },
    {
      label: 'PERCENT LEFT',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: `$(account) Claude · ${switcher.active?.label ?? 'no account'}   ${windowsText(q)}`,
      description: nextReset(q),
      detail: 'Pick to switch or add an account',
      action: () => switcher.menu(),
    },
    {
      label: `$(terminal) Codex   ${windowsText(codexW)}`,
      description: nextReset(codexW),
      detail: `${codex.requests} requests · ${codex.totalTokens ? `${Math.round(codex.totalTokens / 1000)}k` : '0'} tokens`,
    },
    {
      label: `$(sparkle) ${cfg.antigravityLabel || 'AGY'}   ${windowsText(geminiW)}`,
      description: nextReset(geminiW),
      detail: `Gemini models${agy.claudeGpt?.fiveHour ? ` · Claude & GPT models: ${Math.round(agy.claudeGpt.fiveHour.remainingPercent)}% of 5h` : ''}`,
    },
    {
      label: 'ACTIONS',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: '$(refresh) Refresh All Quotas Now',
      description: 'Query live CLIs for fresh rate limits',
      action: async () => {
        resetAntigravityCache();
        await switcher.tick(true);
        output.show(true);
        output.appendLine('[Quota Relay] Force-refreshing all provider quotas...');
        paintStatus();
        vscode.window.showInformationMessage('Quota Relay: All quotas refreshed.');
      },
    },
    {
      label: '$(arrow-swap) Change Default Worker...',
      description: `Current default: ${cfg.defaultWorker}`,
      action: async () => {
        const choice = await vscode.window.showQuickPick([
          { label: 'Auto', description: 'Usage-aware dynamic routing', value: 'auto' as WorkerSelection },
          { label: 'Claude Code', description: 'Primary Claude Code CLI', value: 'claude' as WorkerSelection },
          { label: 'Codex', description: 'OpenAI Codex CLI', value: 'codex' as WorkerSelection }
        ], { placeHolder: 'Select default worker' });
        if (choice) {
          await vscode.workspace.getConfiguration('quotaRelay').update('defaultWorker', choice.value, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Quota Relay: Default worker set to ${choice.label}.`);
          paintStatus();
        }
      },
    },
    {
      label: '$(comment-discussion) Open Agent Chat Panel',
      description: 'Multi-turn conversation preserving context across workers',
      action: () => {
        ChatPanel.show(extensionContext, manager, readConfig().modelIds as Record<string, string | undefined>, readConfig().taskTimeoutMs);
      },
    },
    {
      label: '$(output) View Full Output Report',
      description: 'Print complete quota and activity details to Output channel',
      action: () => {
        output.show(true);
        output.appendLine('\n=================== AI SWITCHBOARD TELEMETRY ===================');
        output.appendLine(`Timestamp: ${new Date().toLocaleString()}`);
        output.appendLine(`Claude (${switcher.active?.label ?? '?'}): ${windowsText(q)}${nextReset(q) ? `, ${nextReset(q)}` : ''}`);
        output.appendLine(`Codex: ${windowsText(codexW)}${nextReset(codexW) ? `, ${nextReset(codexW)}` : ''}`);
        output.appendLine(describeAntigravityUsage(agy));
        output.appendLine('================================================================\n');
      },
    },
    {
      label: '$(key) Check CLI Authentication',
      description: 'Verify login state for claude, codex, and agy',
      action: () => checkAuth(),
    },
    {
      label: '$(gear) Configure Settings & Ladders...',
      description: 'Adjust model thresholds, status bar layout, and CLI paths',
      action: () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'quotaRelay');
      },
    },
  ];

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Quota Relay: Model Router & Quota Hub',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (selection?.action) {
    await selection.action();
  }
}

// ---------------------------------------------------------------------------
// TASK & CHAT OPERATIONS
// ---------------------------------------------------------------------------

async function runTask(resume?: AgentTask): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const prompt = resume?.prompt ?? await vscode.window.showInputBox({
    prompt: 'Describe the task for a local CLI worker',
    placeHolder: 'Review this file and suggest improvements'
  });
  if (!prompt) return;
  const profiles = readConfig().profiles;
  const worker = resume ? { value: resume.worker } : await vscode.window.showQuickPick([
    { label: 'Auto', description: 'Usage-aware routing', value: 'auto' as WorkerSelection },
    ...(['codex', 'claude'] as WorkerId[]).map(id => ({ label: profiles[id].label, description: profiles[id].modelLabel, value: id as WorkerSelection }))
  ], { placeHolder: 'Select worker (manual override)' });
  if (!worker) return;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? editor?.document.uri.fsPath ?? process.cwd();
  const context = editor ? { file: editor.document.uri.fsPath, selection: editor.document.getText(editor.selection), language: editor.document.languageId } : undefined;
  const risky = /\b(delete|remove|overwrite|install|deploy|push|force|sudo|chmod)\b/i.test(prompt);
  if (risky && !(await vscode.window.showWarningMessage('This task may modify files or run privileged commands.', { modal: true }, 'Approve'))) return;
  const task: AgentTask = resume ? { ...resume, status: 'queued', updatedAt: Date.now(), error: undefined, activity: [...resume.activity, 'Resumed'] } : { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, prompt, cwd, worker: worker.value as WorkerSelection, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), context, activity: [] };
  await saveTask(task);
  output.clear(); output.show(true); vscode.window.setStatusBarMessage(`$(sync~spin) Running task on ${worker.value}...`, 10000);
  try {
    task.status = 'running'; task.updatedAt = Date.now(); task.activity.push(`Started ${worker.value}`); await saveTask(task);
    const contextualPrompt = context?.file ? `${prompt}\n\nWorkspace context:\n- Active file: ${context.file}\n- Language: ${context.language}\n- Selection:\n${context.selection || '(none)'}` : prompt;
    const result = await manager.run({ prompt: contextualPrompt, cwd, worker: worker.value, timeoutMs: readConfig().taskTimeoutMs, context }, chunk => { output.append(chunk.text); task.activity.push(chunk.text.slice(0, 160)); task.updatedAt = Date.now(); void saveTask(task); });
    task.status = result.exitCode === 0 ? 'completed' : 'failed'; task.result = result; task.updatedAt = Date.now(); task.activity.push(`Exited ${result.exitCode ?? 'unknown'}`); await saveTask(task);
    const history = contextState.get<Array<{ prompt: string; worker: string; at: number }>>(historyKey, []);
    await contextState.update(historyKey, [...history.slice(-49), { prompt, worker: result.worker, at: Date.now() }]);
    paintStatus();
    if ((result.attempts?.length ?? 0) > 1) {
      output.appendLine(`\n>> Done by ${result.worker} after trying ${result.attempts!.join(' then ')}.`);
    }
    if (result.exitCode !== 0) vscode.window.showErrorMessage(`${result.worker} exited with code ${result.exitCode}`);
  } catch (error) {
    task.status = /cancel/i.test(String(error)) ? 'cancelled' : 'failed';
    task.error = String(error);
    task.updatedAt = Date.now();
    task.activity.push(task.error);
    await saveTask(task);
    paintStatus();
    vscode.window.showErrorMessage(String(error));
  }
}

async function chat(): Promise<void> {
  const text = await vscode.window.showInputBox({
    prompt: 'Message',
    placeHolder: 'Ask anything; it continues on whichever worker has quota'
  });
  if (!text) return;
  const stored = contextState.get<Conversation>(convKey);
  const conv = stored ?? newConversation();
  const cfg = readConfig();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  output.show(true);
  output.appendLine(`\nYou: ${text}`);
  vscode.window.setStatusBarMessage('$(sync~spin) Waiting for AI reply...', 15000);
  try {
    const reply = await say(manager, conv, text, { cwd, timeoutMs: cfg.taskTimeoutMs });
    const models = cfg.modelIds as Record<string, string | undefined>;
    const who = `${reply.worker}${models[reply.worker] ? ` (${models[reply.worker]})` : ''}`;
    if (reply.replayed) output.appendLine(`>> ${who} picked the conversation up and was given the transcript.`);
    output.appendLine(`${who}: ${reply.text}`);
    if (reply.tokens) output.appendLine(`   [${reply.tokens.input ?? '?'} in / ${reply.tokens.output ?? '?'} out]`);
    await contextState.update(convKey, conv);
    vscode.window.setStatusBarMessage(`$(check) Replied by ${reply.worker}`, 4000);
  } catch (error) {
    output.appendLine(`!! ${String(error)}`);
    vscode.window.showErrorMessage(String(error));
  }
}

async function newChat(): Promise<void> {
  await contextState.update(convKey, undefined);
  output.appendLine('\n-- new conversation --');
  vscode.window.showInformationMessage('Quota Relay: started a new conversation.');
}

async function saveTask(task: AgentTask): Promise<void> {
  const tasks = contextState.get<AgentTask[]>(tasksKey, []).filter(t => t.id !== task.id);
  await contextState.update(tasksKey, [...tasks, task].slice(-100));
  taskTree?.refresh();
}

async function showWorkers(): Promise<void> {
  const profiles = readConfig().profiles;
  const items = manager.snapshots().map(s => `${profiles[s.worker].label} (${profiles[s.worker].modelLabel}): ${s.running ? 'running' : 'idle'} · completed ${s.completed} · failures ${s.failures} · usage ${s.usage.state}${s.usageThresholdReached ? ' (threshold)' : ''}`);
  await vscode.window.showQuickPick(items, { placeHolder: 'Worker usage' });
}

function describeAntigravityUsage(usage: AntigravityUsage): string {
  if (usage.error && (!usage.groups || usage.groups.length === 0)) {
    return `Antigravity quota unavailable: ${usage.error}`;
  }
  const lines: string[] = ['Antigravity Limits:'];
  for (const group of usage.groups) {
    const parts: string[] = [];
    if (group.fiveHour) {
      const reset = group.fiveHour.resetsAt ? new Date(group.fiveHour.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown';
      parts.push(`5h: ${group.fiveHour.usedPercent}% used (${group.fiveHour.remainingPercent}% left, resets ${reset})`);
    }
    if (group.weekly) {
      const reset = formatResetDate(group.weekly.resetsAt);
      parts.push(`Weekly: ${group.weekly.usedPercent}% used (${group.weekly.remainingPercent}% left, resets ${reset})`);
    }
    lines.push(`- ${group.name}: ${parts.join('; ')}`);
  }
  if (usage.conversationsCount !== undefined) {
    lines.push(`Local activity: ${usage.conversationsCount} conversations, ${usage.totalSteps ?? 0} steps recorded.`);
  }
  return lines.join('\n');
}

function formatResetDate(timestamp: number | undefined): string {
  return timestamp
    ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'unknown';
}

async function openWorkerTerminal(): Promise<void> {
  const worker = await vscode.window.showQuickPick(['codex', 'claude'], { placeHolder: 'Open visible terminal for worker' });
  if (!worker) return;
  const existing = terminals.get(worker as WorkerId);
  if (existing) { existing.show(); return; }
  const terminal = vscode.window.createTerminal({ name: `Worker: ${worker}`, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
  terminals.set(worker as WorkerId, terminal);
  terminal.processId.then(id => output.appendLine(`[${worker}] terminal process ${id ?? 'unknown'} started`));
  terminal.show();
}

async function checkAuth(): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const results = await Promise.all((Object.keys(adapters) as WorkerId[]).map(async id => [id, await adapters[id].checkAuth(cwd)] as const));
  const message = results.map(([id, result]) => `${id}: ${result.detail}`).join('\n');
  output.appendLine(`Authentication check:\n${message}`);
  vscode.window.showInformationMessage(message);
}

export function deactivate(): void { manager?.cancelActive(); }

