import * as vscode from 'vscode';
import { readConfig, WorkerConfig } from './config';
import { createAdapters } from './adapters';
import { say, newConversation } from './chat';
import { ChatPanel } from './panel';
import { readQuota, planFor } from './quota';
import { Switcher } from './switcher';
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

function formatRelativeReset(resetsAt: number | undefined): string {
  if (!resetsAt) return 'unknown';
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return 'resets soon';
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const hours = Math.floor(diffMinutes / 60);
  const mins = diffMinutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function formatShortEnd(resetsAt: number | undefined): string {
  if (!resetsAt) return '';
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return 'ends soon';
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 60) return `ends in ${diffMinutes}m`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `ends in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `ends in ${days}d`;
}

function formatExactDate(resetsAt: number): string {
  const d = new Date(resetsAt);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${month} ${day} at ${time}`;
}

interface ProviderBadgeInfo {
  label: string;
  fiveHourPercent?: number;
  fiveHourResetsAt?: number;
  weeklyPercent?: number;
  weeklyResetsAt?: number;
  extraDetails?: string[];
  error?: string;
}

function cleanProviderBadge(info: ProviderBadgeInfo): {
  text: string;
  tooltip: vscode.MarkdownString;
  color: vscode.ThemeColor;
} {
  const { label, fiveHourPercent, fiveHourResetsAt, weeklyPercent, weeklyResetsAt, extraDetails, error } = info;

  if (error && fiveHourPercent === undefined && weeklyPercent === undefined) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### ${label} Quota Status\n\n`);
    md.appendMarkdown(`⚠️ *${error}*\n\n`);
    md.appendMarkdown(`_👉 Click this badge to refresh live usage._`);
    return {
      text: `$(circle-outline) ${label} ?`,
      tooltip: md,
      color: new vscode.ThemeColor('disabledForeground')
    };
  }

  const fiveH = fiveHourPercent !== undefined ? Math.max(0, Math.min(100, Math.round(fiveHourPercent))) : undefined;
  const fiveHUsed = fiveH !== undefined ? 100 - fiveH : undefined;

  const weekly = weeklyPercent !== undefined ? Math.max(0, Math.min(100, Math.round(weeklyPercent))) : undefined;
  const weeklyUsed = weekly !== undefined ? 100 - weekly : undefined;

  // The primary quota figure for health color is the 5-Hour window!
  const effectiveRemaining = fiveH ?? weekly ?? 100;

  let colorToken = 'charts.green';
  let paceLabel = 'Healthy quota level';
  if (effectiveRemaining <= 0) {
    colorToken = 'charts.red';
    paceLabel = 'Out of quota';
  } else if (effectiveRemaining <= 15) {
    colorToken = 'charts.red';
    paceLabel = 'Low quota warning';
  } else if (effectiveRemaining <= 30) {
    colorToken = 'charts.yellow';
    paceLabel = 'Moderate quota level';
  }

  // 5h Reset column
  const fiveHResetRel = formatRelativeReset(fiveHourResetsAt);
  const fiveHResetExact = fiveHourResetsAt ? new Date(fiveHourResetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined;
  const fiveHResetCol = fiveHourResetsAt
    ? (fiveHResetExact ? `in ${fiveHResetRel} (${fiveHResetExact})` : `in ${fiveHResetRel}`)
    : 'Active / Reset';

  // Weekly Reset column
  const weeklyResetRel = formatRelativeReset(weeklyResetsAt);
  const weeklyResetExact = weeklyResetsAt ? formatExactDate(weeklyResetsAt) : undefined;
  const weeklyResetCol = weeklyResetsAt
    ? (weeklyResetExact ? `in ${weeklyResetRel} (${weeklyResetExact})` : `in ${weeklyResetRel}`)
    : '—';

  // Format short badge text: e.g. "Claude 11% (5h) · 7d 48% (ends in 4d)"
  const fiveHStr = fiveH !== undefined ? `${fiveH}%` : '—';
  const weeklyEndsStr = formatShortEnd(weeklyResetsAt);
  const weeklyBadgePart = weekly !== undefined
    ? (weeklyEndsStr ? `7d ${weekly}% (${weeklyEndsStr})` : `7d ${weekly}%`)
    : '';

  const badgeText = weeklyBadgePart
    ? `${label} ${fiveHStr} (5h) · ${weeklyBadgePart}`
    : `${label} ${fiveHStr} (5h)`;

  // Tooltip with callout highlighting the 5h Main window!
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`### ${label} Quota Status\n\n`);
  md.appendMarkdown(`_👉 Click this badge to refresh live usage_\n\n`);

  md.appendMarkdown(`> ⚡ **Main Active Limit: 5-Hour Session**  \n`);
  md.appendMarkdown(`> **\`${fiveHStr}\`** remaining · ${fiveHourResetsAt ? `Resets ${fiveHResetCol}` : 'Window active / reset'}\n\n`);

  md.appendMarkdown(`| Quota Window | Remaining | Used | Ends / Resets In |\n| :--- | :---: | :---: | :--- |\n`);
  md.appendMarkdown(`| ⭐ **5-Hour Session (Main)** | **\`${fiveHStr}\`** | ${fiveHUsed !== undefined ? `\`${fiveHUsed}%\`` : '—'} | ${fiveHResetCol} |\n`);
  if (weekly !== undefined || weeklyResetsAt) {
    md.appendMarkdown(`| 📅 **Weekly Ceiling (7-Day)** | \`${weekly !== undefined ? `${weekly}%` : '—'}\` | ${weeklyUsed !== undefined ? `\`${weeklyUsed}%\`` : '—'} | ${weeklyResetCol} |\n`);
  }
  md.appendMarkdown(`\n---\n`);
  md.appendMarkdown(`*Status: ${paceLabel}*\n\n`);
  if (extraDetails && extraDetails.length > 0) {
    for (const d of extraDetails) {
      md.appendMarkdown(`*${d}*\n\n`);
    }
  }
  md.appendMarkdown(`_👉 Click this badge to refresh ${label} usage_`);

  return {
    text: `$(circle-filled) ${badgeText}`,
    tooltip: md,
    color: new vscode.ThemeColor(colorToken)
  };
}

function cleanAntigravityBadge(label: string, agy: AntigravityUsage): {
  text: string;
  tooltip: vscode.MarkdownString;
  color: vscode.ThemeColor;
} {
  if (agy.error && (!agy.groups || agy.groups.length === 0)) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### ${label} Quota Status\n\n⚠️ *${agy.error}*\n\n_👉 Click to refresh live usage._`);
    return {
      text: `$(circle-outline) ${label} ?`,
      tooltip: md,
      color: new vscode.ThemeColor('disabledForeground')
    };
  }

  const gemini5h = agy.gemini?.fiveHour?.remainingPercent ?? agy.primary?.remainingPercent;
  const gemini5hResets = agy.gemini?.fiveHour?.resetsAt ?? agy.primary?.resetsAt;
  const geminiW = agy.gemini?.weekly?.remainingPercent ?? agy.groups?.[0]?.weekly?.remainingPercent;
  const geminiWResets = agy.gemini?.weekly?.resetsAt ?? agy.groups?.[0]?.weekly?.resetsAt;

  const gpt5h = agy.claudeGpt?.fiveHour?.remainingPercent;
  const gpt5hResets = agy.claudeGpt?.fiveHour?.resetsAt;
  const gptW = agy.claudeGpt?.weekly?.remainingPercent;
  const gptWResets = agy.claudeGpt?.weekly?.resetsAt;

  // Determine overall health color:
  // If Gemini is low, warning/red. If 3P (Opus/GPT) is low/exhausted, yellow warning.
  let colorToken = 'charts.green';
  if (gemini5h !== undefined && gemini5h <= 0) {
    colorToken = 'charts.red';
  } else if ((gemini5h !== undefined && gemini5h <= 20) || (gpt5h !== undefined && gpt5h <= 0)) {
    colorToken = 'charts.yellow';
  }

  // Format short badge text: e.g. "Antigravity Gem 35% · Opus 0% (5h) · 7d 45% (ends 2d)"
  const gem5hStr = gemini5h !== undefined ? `${gemini5h}%` : '—';
  const gpt5hStr = gpt5h !== undefined ? `${gpt5h}%` : '—';
  const weeklyEnds = formatShortEnd(geminiWResets);
  const weeklyPart = geminiW !== undefined ? (weeklyEnds ? `7d ${geminiW}% (${weeklyEnds})` : `7d ${geminiW}%`) : '';

  const badgeText = weeklyPart
    ? `${label} Gem ${gem5hStr} · Opus ${gpt5hStr} (5h) · ${weeklyPart}`
    : `${label} Gem ${gem5hStr} · Opus ${gpt5hStr} (5h)`;

  // Formatted resets for table
  const gem5hReset = gemini5hResets ? `in ${formatRelativeReset(gemini5hResets)}` : '—';
  const gemWReset = geminiWResets ? `in ${formatRelativeReset(geminiWResets)} (${formatExactDate(geminiWResets)})` : '—';

  const gpt5hReset = gpt5hResets ? `in ${formatRelativeReset(gpt5hResets)}` : '—';
  const gptWReset = gptWResets ? `in ${formatRelativeReset(gptWResets)} (${formatExactDate(gptWResets)})` : '—';

  // Tooltip with callout and coherent comparison table
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`### ${label} Quota Status\n\n`);
  md.appendMarkdown(`_👉 Click this badge to refresh live usage_\n\n`);

  md.appendMarkdown(`> ⚡ **Main Active Limits (5-Hour Session)**  \n`);
  md.appendMarkdown(`> • **Gemini (Flash / Pro):** **\`${gem5hStr}\`** remaining · Resets ${gem5hReset}  \n`);
  md.appendMarkdown(`> • **Claude Opus & GPT (3P):** **\`${gpt5hStr}\`** remaining · Resets ${gpt5hReset}\n\n`);

  md.appendMarkdown(`| Model Family | 5-Hour Session (Main) | Weekly Ceiling (7-Day) | Status |\n| :--- | :---: | :---: | :--- |\n`);
  md.appendMarkdown(`| 🔷 **Gemini Models** *(Flash, Pro)* | **\`${gem5hStr}\`** *(${gem5hReset})* | \`${geminiW !== undefined ? `${geminiW}%` : '—'}\` *(${gemWReset})* | ${gemini5h !== undefined && gemini5h <= 0 ? 'Exhausted' : 'Healthy burn pace'} |\n`);
  md.appendMarkdown(`| 🔶 **Claude & GPT** *(Opus, Sonnet, GPT)* | **\`${gpt5hStr}\`** *(${gpt5hReset})* | \`${gptW !== undefined ? `${gptW}%` : '—'}\` *(${gptWReset})* | ${gpt5h !== undefined && gpt5h <= 0 ? '⚠️ 5h window exhausted' : 'Healthy burn pace'} |\n`);

  md.appendMarkdown(`\n---\n`);
  if (agy.conversationsCount !== undefined) {
    md.appendMarkdown(`*Local Activity: ${agy.conversationsCount} conversations · ${agy.totalSteps ?? 0} steps recorded across CLI and IDE databases*\n\n`);
  }
  md.appendMarkdown(`_👉 Click this badge to refresh ${label} usage_`);

  return {
    text: `$(circle-filled) ${badgeText}`,
    tooltip: md,
    color: new vscode.ThemeColor(colorToken)
  };
}

function paintStatus(): void {
  if (!codexUsageStatus || !antigravityUsageStatus) return;
  const cfg = readConfig();
  const codex = readCodexUsage();
  const agy = readAntigravityUsage({ command: cfg.antigravityCommand });

  // 2. Codex
  const codexFiveH = codex.primary?.usedPercent !== undefined ? 100 - codex.primary.usedPercent : undefined;
  const codexWeekly = codex.secondary?.usedPercent !== undefined ? 100 - codex.secondary.usedPercent : undefined;
  const codexDetails: string[] = [];
  if (codex.requests > 0 || codex.totalTokens > 0) {
    const tokensM = (codex.totalTokens / 1_000_000).toFixed(1);
    codexDetails.push(`Local Activity: ${codex.requests} requests · ${tokensM}M tokens (${codex.lastModel ?? 'latest'})`);
  }
  const codexBadge = cleanProviderBadge({
    label: 'Codex',
    fiveHourPercent: codexFiveH,
    fiveHourResetsAt: codex.primary?.resetsAt,
    weeklyPercent: codexWeekly,
    weeklyResetsAt: codex.secondary?.resetsAt,
    extraDetails: codexDetails,
    error: codex.error
  });
  codexUsageStatus.text = codexBadge.text;
  codexUsageStatus.tooltip = codexBadge.tooltip;
  codexUsageStatus.color = codexBadge.color;

  // 3. Antigravity (coherent dual-limit display for Gemini & Claude/Opus)
  const agyLabel = cfg.antigravityLabel || 'Antigravity';
  const agyBadge = cleanAntigravityBadge(agyLabel, agy);
  antigravityUsageStatus.text = agyBadge.text;
  antigravityUsageStatus.tooltip = agyBadge.tooltip;
  antigravityUsageStatus.color = agyBadge.color;
}

async function refreshClaudeUsage(showFeedback = true): Promise<void> {
  await switcher.tick(true);
  const q = switcher.activeQuota();
  if (showFeedback && q && !q.error) {
    vscode.window.setStatusBarMessage(`$(check) Claude ${switcher.active?.label ?? ''}: 5h ${q.fiveHour ?? '—'}% · week ${q.sevenDay ?? '—'}%`, 5000);
  }
}

async function refreshCodexUsage(showFeedback = true): Promise<void> {
  codexUsageStatus.text = '$(sync~spin) Codex...';
  try {
    const codex = readCodexUsage();
    paintStatus();
    if (showFeedback) {
      const fiveH = codex.primary?.usedPercent !== undefined ? `${Math.round(100 - codex.primary.usedPercent)}%` : '—';
      const weekly = codex.secondary?.usedPercent !== undefined ? `${Math.round(100 - codex.secondary.usedPercent)}%` : '—';
      const endsIn = formatShortEnd(codex.secondary?.resetsAt);
      const endsPart = endsIn ? ` (${endsIn})` : '';
      vscode.window.setStatusBarMessage(`$(check) Codex refreshed: 5h ${fiveH} · Weekly ${weekly}${endsPart}`, 5000);
    }
  } catch (err) {
    paintStatus();
    vscode.window.showErrorMessage(`Failed to refresh Codex usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function refreshAntigravityUsage(showFeedback = true): Promise<void> {
  const cfg = readConfig();
  const label = cfg.antigravityLabel || 'Antigravity';
  antigravityUsageStatus.text = `$(sync~spin) ${label}...`;
  try {
    resetAntigravityCache();
    const agy = readAntigravityUsage({ command: cfg.antigravityCommand, forceRefresh: true });
    paintStatus();
    if (showFeedback) {
      const fiveH = agy.primary ? `${Math.round(agy.primary.remainingPercent)}%` : '—';
      const weekly = agy.gemini?.weekly ? `${Math.round(agy.gemini.weekly.remainingPercent)}%` : '—';
      const endsIn = formatShortEnd(agy.gemini?.weekly?.resetsAt);
      const endsPart = endsIn ? ` (${endsIn})` : '';
      vscode.window.setStatusBarMessage(`$(check) ${label} refreshed: 5h ${fiveH} · Weekly ${weekly}${endsPart}`, 5000);
    }
  } catch (err) {
    paintStatus();
    vscode.window.showErrorMessage(`Failed to refresh Antigravity usage: ${err instanceof Error ? err.message : String(err)}`);
  }
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

function describeAntigravityCompact(agy: AntigravityUsage): string {
  if (agy.error && (!agy.groups || agy.groups.length === 0)) {
    return `Error: ${agy.error}`;
  }
  const parts: string[] = [];
  if (agy.gemini?.fiveHour) {
    parts.push(`Gemini: ${agy.gemini.fiveHour.remainingPercent}% left`);
  }
  if (agy.claudeGpt?.fiveHour) {
    parts.push(`3P: ${agy.claudeGpt.fiveHour.remainingPercent}% left`);
  }
  if (agy.conversationsCount !== undefined) {
    parts.push(`${agy.conversationsCount} convos (${agy.totalSteps ?? 0} steps)`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Active';
}

async function showQuotaQuickPick(provider?: 'claude' | 'codex' | 'antigravity' | 'gemini'): Promise<void> {
  const cfg = readConfig();
  const q = switcher.activeQuota() ?? readQuota();
  const codex = readCodexUsage();
  const agy = readAntigravityUsage({ command: cfg.antigravityCommand, forceRefresh: true });

  const claudeRemaining = typeof q.fiveHour === 'number' ? Math.round(q.fiveHour) : undefined;
  const codexRemaining = codex.primary?.usedPercent !== undefined ? Math.round(100 - codex.primary.usedPercent) : undefined;
  const agyRemaining = agy.primary ? Math.round(agy.primary.remainingPercent) : undefined;

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
      detail: claudeRemaining !== undefined
        ? `Claude remaining window: ${claudeRemaining}%. Fallback below ${cfg.thresholds.saverBelow}% will switch to Codex.`
        : 'Dynamic worker selection based on task and capacity.',
    },
    {
      label: 'SUBSCRIPTION QUOTAS',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: `$(account) Claude (${switcher.active?.label ?? 'no account'}) — ${claudeRemaining !== undefined ? `${claudeRemaining}% left` : 'Unknown'}`,
      description: q.fiveHourResetsAt ? `Resets in ${formatRelativeReset(q.fiveHourResetsAt)} (${new Date(q.fiveHourResetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : undefined,
      detail: `5h window: ${claudeRemaining !== undefined ? `${100 - claudeRemaining}% used` : '?'} · 7-day: ${q.sevenDay !== undefined ? `${Math.round(100 - q.sevenDay)}% used` : 'N/A'}${q.ageMinutes ? ` · Cache age: ${Math.round(q.ageMinutes)}m` : ''}`,
      action: () => switcher.menu(),
    },
    {
      label: `$(circle-filled) OpenAI Codex — ${codexRemaining !== undefined ? `${codexRemaining}% left` : 'Unknown'}`,
      description: codex.primary?.resetsAt ? `Resets in ${formatRelativeReset(codex.primary.resetsAt)}` : undefined,
      detail: `5h: ${Math.round(codex.primary?.usedPercent ?? 0)}% used · 7d: ${Math.round(codex.secondary?.usedPercent ?? 0)}% used · Requests: ${codex.requests} · Tokens: ${codex.totalTokens ? `${Math.round(codex.totalTokens / 1000)}k` : '0'}`,
    },
    {
      label: `$(circle-filled) Antigravity — ${agyRemaining !== undefined ? `${agyRemaining}% left` : 'Unknown'}`,
      description: agy.primary?.resetsAt ? `Resets in ${formatRelativeReset(agy.primary.resetsAt)}` : undefined,
      detail: describeAntigravityCompact(agy),
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
        output.appendLine(`Claude: 5h left ${claudeRemaining ?? '?'}%, resets ${q.fiveHourResetsAt ? new Date(q.fiveHourResetsAt).toLocaleTimeString() : 'N/A'}`);
        output.appendLine(`Codex: 5h left ${codexRemaining ?? '?'}%, resets ${codex.primary?.resetsAt ? new Date(codex.primary.resetsAt).toLocaleTimeString() : 'N/A'}`);
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

