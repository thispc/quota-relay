import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexUsage {
  requests: number;
  totalTokens: number;
  lastModel?: string;
  updatedAt?: number;
  primary?: CodexWindow;
  secondary?: CodexWindow;
  error?: string;
}

export interface CodexWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexUsageRow {
  ts: number;
  body: string;
}

/** Parses Codex's local structured log rows without exposing prompts or credentials. */
export function parseCodexUsageRows(rows: readonly CodexUsageRow[]): CodexUsage {
  let totalTokens = 0;
  let requests = 0;
  let lastModel: string | undefined;
  let updatedAt: number | undefined;
  for (const row of rows) {
    const usage = row.body.match(/post sampling token usage.*?total_usage_tokens=(\d+)/);
    if (!usage) continue;
    totalTokens += Number(usage[1]);
    requests += 1;
    lastModel = row.body.match(/\bmodel=([^\s}]+)/)?.[1] ?? lastModel;
    updatedAt = Math.max(updatedAt ?? 0, row.ts * 1000);
  }
  return {
    requests,
    totalTokens,
    ...(lastModel ? { lastModel } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function readCodexUsage(
  home = join(homedir(), '.codex'),
  runSqlite: (database: string, query: string) => string = querySqlite,
): CodexUsage {
  const database = findLogsDatabase(home);
  if (!database) return { requests: 0, totalTokens: 0, error: 'Codex usage log database not found' };
  try {
    const raw = runSqlite(database,
      "select ts, feedback_log_body from logs where feedback_log_body like '%post sampling token usage%' order by ts asc;");
    const rows = raw.split('\n').filter(Boolean).map((line) => {
      const [ts, ...body] = line.split('\t');
      return { ts: Number(ts), body: body.join('\t') };
    }).filter((row) => Number.isFinite(row.ts) && row.body);
    return { ...parseCodexUsageRows(rows), ...readLatestRateLimits(home) };
  } catch (error) {
    return { requests: 0, totalTokens: 0, error: `Codex usage could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  function readLatestRateLimits(home: string): Pick<CodexUsage, 'primary' | 'secondary'> {
    const files = sessionFiles(join(home, 'sessions')).sort();
    let latest: { primary?: CodexWindow; secondary?: CodexWindow; at: number } | undefined;
    let knownPrimary: CodexWindow | undefined;
    let knownSecondary: CodexWindow | undefined;
    for (const file of files) {
      let contents: string;
      try { contents = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of contents.split('\n')) {
        try {
          const event = JSON.parse(line) as { timestamp?: string; payload?: { rate_limits?: RateLimitPayload } };
          const limits = event.payload?.rate_limits;
          if (!limits) continue;
          const at = event.timestamp ? Date.parse(event.timestamp) : 0;
          const primary = toWindow(limits.primary);
          const secondary = toWindow(limits.secondary);
          if (primary) knownPrimary = primary;
          if (secondary) knownSecondary = secondary;
          if (!latest || at >= latest.at) latest = {
            at,
            primary: primary ?? emptyWindow(limits, knownPrimary, 100),
            secondary: secondary ?? emptyWindow(limits, knownSecondary),
          };
        } catch { /* Ignore incomplete rollout lines. */ }
      }
    }
    if (latest) {
      const now = Date.now();
      if (latest.primary?.resetsAt && latest.primary.resetsAt <= now) {
        latest.primary = {
          usedPercent: 0,
          windowMinutes: latest.primary.windowMinutes ?? 300,
          resetsAt: undefined,
        };
      }
      if (latest.secondary?.resetsAt && latest.secondary.resetsAt <= now) {
        latest.secondary = {
          usedPercent: 0,
          windowMinutes: latest.secondary.windowMinutes ?? 10080,
          resetsAt: undefined,
        };
      }
    }
    return latest ? { primary: latest.primary, secondary: latest.secondary } : {};
  }

  interface RateLimitPayload {
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
    secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
    credits?: { has_credits?: boolean };
  }

  function toWindow(value: RateLimitPayload['primary']): CodexWindow | undefined {
    if (!value || typeof value.used_percent !== 'number') return undefined;
    return {
      usedPercent: value.used_percent,
      windowMinutes: value.window_minutes,
      resetsAt: typeof value.resets_at === 'number' ? value.resets_at * 1000 : undefined,
    };
  }

  function emptyWindow(value: RateLimitPayload, previous: CodexWindow | undefined, exhaustedPercent?: number): CodexWindow | undefined {
    if (value.credits?.has_credits !== false) return undefined;
    if (exhaustedPercent === undefined && !previous) return undefined;
    return previous
      ? { ...previous, ...(exhaustedPercent === undefined ? {} : { usedPercent: exhaustedPercent }) }
      : { usedPercent: exhaustedPercent!, windowMinutes: 300 };
  }

  function sessionFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...sessionFiles(path));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
    return files;
  }

}

function findLogsDatabase(home: string): string | undefined {
  const entries = readdirSync(home, { withFileTypes: true })
    .filter((entry) => /^logs_\d+\.sqlite$/.test(entry.name))
    .map((entry) => join(home, entry.name))
    .filter(existsSync);
  return entries.sort().at(-1);
}

function querySqlite(database: string, query: string): string {
  return execFileSync('sqlite3', ['-noheader', '-separator', '\t', database, query], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
