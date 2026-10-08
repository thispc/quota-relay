import * as vscode from 'vscode';
import { WorkerId, WorkerSelection, WorkerProfile } from './models';
import { QuotaThresholds, DEFAULT_THRESHOLDS } from './quota';

export type StatusBarLayout = 'separated' | 'consolidated' | 'active-only';

export interface WorkerConfig {
  managerModel: string;
  defaultWorker: WorkerSelection;
  commands: Record<WorkerId, string>;
  maxConcurrentTasks: number;
  taskTimeoutMs: number;
  showWorkerTerminals: boolean;
  failureThreshold: number;
  usageThreshold: number;
  codexSandbox: string;
  limitedCooldownMs: number;
  modelIds: Partial<Record<WorkerId, string>>;
  powerSaver: boolean;
  thresholds: QuotaThresholds;
  antigravityCommand: string;
  antigravityLabel: string;
  statusBarLayout: StatusBarLayout;
  profiles: Record<WorkerId, WorkerProfile>;
}

export function readConfig(): WorkerConfig {
  // the current name first, then what earlier versions were called, so old settings keep working
  const sections = ['quotaRelay', 'aiSwitchboard', 'localCliWorkers'].map(n => vscode.workspace.getConfiguration(n));

  function getSetting<T>(key: string, defaultValue: T): T {
    for (const sec of sections) {
      const i = sec.inspect<T>(key);
      if (i && (i.globalValue !== undefined || i.workspaceValue !== undefined || i.workspaceFolderValue !== undefined)) {
        return sec.get<T>(key, defaultValue);
      }
    }
    return sections[0].get<T>(key, defaultValue);
  }

  return {
    managerModel: getSetting<string>('managerModel', 'local manager'),
    defaultWorker: getSetting<WorkerSelection>('defaultWorker', 'auto'),
    commands: {
      codex: getSetting<string>('codexCommand', 'codex'),
      claude: getSetting<string>('claudeCommand', 'claude')
    },
    antigravityCommand: getSetting<string>('antigravityCommand', 'agy'),
    antigravityLabel: getSetting<string>('antigravityLabel', 'Antigravity'),
    statusBarLayout: getSetting<StatusBarLayout>('statusBarLayout', 'separated'),
    codexSandbox: getSetting<string>('codexSandbox', 'read-only'),
    modelIds: {
      codex: getSetting<string>('codexModelId', '') || undefined,
      claude: getSetting<string>('claudeModelId', 'sonnet') || undefined
    },
    powerSaver: getSetting<boolean>('powerSaver.enabled', true),
    thresholds: {
      ladder: getSetting<Array<{ atLeast: number; model: string }>>('powerSaver.ladder', DEFAULT_THRESHOLDS.ladder),
      saverBelow: getSetting<number>('powerSaver.saverBelowPercent', 30)
    },
    limitedCooldownMs: getSetting<number>('limitedCooldownMs', 1800000),
    maxConcurrentTasks: getSetting<number>('maxConcurrentTasks', 1),
    taskTimeoutMs: getSetting<number>('taskTimeoutMs', 600000),
    showWorkerTerminals: getSetting<boolean>('showWorkerTerminals', true),
    failureThreshold: getSetting<number>('failureThreshold', 3),
    usageThreshold: getSetting<number>('usageThreshold', 0),
    profiles: {
      codex: { id: 'codex', label: 'Codex', modelLabel: getSetting<string>('codexModel', 'local Codex CLI'), command: getSetting<string>('codexCommand', 'codex'), enabled: true },
      claude: { id: 'claude', label: 'Claude Code', modelLabel: getSetting<string>('claudeModel', 'local Claude Code CLI'), command: getSetting<string>('claudeCommand', 'claude'), enabled: true }
    }
  };
}
