import { spawn, ChildProcess } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { WorkerAdapter, WorkerId, TaskRequest, TaskHandle, TaskResult, StreamChunk, AuthStatus } from './models';

/** What each CLI says when the subscription's window is spent, rather than when the task itself went wrong. */
const RATE_LIMITED = /rate.?limit|usage limit|quota|too many requests|429|limit reached|upgrade to|try again (later|in)|resets? (at|in)|requires usage credits|out of credits|insufficient credits/i;

/** A reset time in the message ("resets at 3pm", "try again in 42 minutes"), as epoch ms, when one is given. */
export function parseResetAt(text: string, now = Date.now()): number | undefined {
  const mins = text.match(/(?:try again in|resets? in)\s+(?:about\s+)?(\d+)\s*(minute|min|hour|hr)/i);
  if (mins) {
    const n = Number(mins[1]);
    return now + n * (/^h/i.test(mins[2]) ? 3_600_000 : 60_000);
  }
  const at = text.match(/resets? at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    const d = new Date(now);
    let h = Number(at[1]);
    if (/pm/i.test(at[3] ?? '') && h < 12) h += 12;
    if (/am/i.test(at[3] ?? '') && h === 12) h = 0;
    d.setHours(h, Number(at[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return undefined;
}

export function isRateLimited(output: string, exitCode: number | null): boolean {
  return exitCode !== 0 && RATE_LIMITED.test(output);
}

/** Whole JSON objects in a chunk of JSONL, skipping partial lines mid-stream. */
export function jsonLines(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { out.push(JSON.parse(s)); } catch { /* the rest of this line is in the next chunk */ }
  }
  return out;
}

/**
 * claude's stream says outright when a window is spent, before the run fails: a rate_limit_event whose status
 * is not "allowed" carries the reset as a unix time. Nothing to guess from an error message.
 */
export function readRateLimitEvent(raw: string): { limited: boolean; resetAt?: number } | undefined {
  for (const e of jsonLines(raw)) {
    const o = e as { type?: string; rate_limit_info?: { status?: string; resetsAt?: number } };
    if (o.type === 'rate_limit_event' && o.rate_limit_info) {
      const info = o.rate_limit_info;
      return { limited: (info.status ?? 'allowed') !== 'allowed',
               resetAt: info.resetsAt ? info.resetsAt * 1000 : undefined };
    }
  }
  return undefined;
}

export class LocalCliAdapter implements WorkerAdapter {
  constructor(public readonly id: WorkerId, private readonly command: string, protected readonly model?: string) {}

  run(request: TaskRequest, onChunk: (chunk: StreamChunk) => void): TaskHandle {
    const started = Date.now();
    let child: ChildProcess | undefined;
    let settled = false;
    let rejectTask: ((reason?: unknown) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<TaskResult>((resolve, reject) => {
      rejectTask = reject;
      try {
        // Prompt is passed as an argument, never through a shell, to avoid injection.
        // stdin must be closed, not inherited: spawned without a tty both CLIs sit waiting for piped input
        // ("no stdin data received in 3s") and the prompt in argv is never run.
        child = spawn(this.command, this.argumentsFor(request.prompt, request.resumeId), {
          cwd: request.cwd, shell: false, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(new Error(`Unable to start ${this.id}: ${String(error)}`)); return;
      }
      const output: string[] = [];
      const collect = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
        const text = data.toString();
        output.push(text); onChunk({ text, stream });
      };
      child.stdout?.on('data', collect('stdout'));
      child.stderr?.on('data', collect('stderr'));
      child.once('error', error => { if (!settled) { settled = true; reject(new Error(`${this.id} process error: ${error.message}`)); } });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const text = output.join('');
        const limited = isRateLimited(text, code);
        const meta = code === 0 ? this.readMeta(text) : {};
        const event = readRateLimitEvent(text);
        const spent = limited || (code !== 0 && event?.limited === true);
        resolve({ worker: this.id, exitCode: code, output: text, durationMs: Date.now() - started,
                  rateLimited: spent, resetAt: spent ? (event?.resetAt ?? parseResetAt(text)) : undefined,
                  sessionId: meta.sessionId, tokens: meta.tokens });
      });
      if (request.timeoutMs) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child?.kill('SIGTERM');
          reject(new Error(`${this.id} task timed out after ${request.timeoutMs}ms`));
        }, request.timeoutMs);
      }
    });
    return {
      promise,
      cancel: () => {
        if (child && !settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          child.kill('SIGTERM');
          rejectTask?.(new Error(`${this.id} task cancelled`));
        }
      }
    };
  }

  async checkAuth(cwd: string): Promise<AuthStatus> {
    return new Promise(resolve => {
      const probe = spawn(this.command, this.authArguments(), { cwd, shell: false, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      probe.stderr?.on('data', d => { stderr += d.toString(); });
      probe.once('error', e => resolve({ authenticated: false, detail: `${this.id} unavailable: ${e.message}` }));
      probe.once('close', code => resolve({ authenticated: code === 0, detail: code === 0 ? `${this.id} is authenticated` : (stderr.trim() || `${this.id} auth check failed`) }));
    });
  }

  protected argumentsFor(prompt: string, _resumeId?: string): string[] { return ['--prompt', prompt]; }
  protected authArguments(): string[] { return ['auth', 'status']; }
  /** The provider's session id and token counts, dug out of whatever the CLI printed. */
  protected readMeta(_output: string): { sessionId?: string; tokens?: { input?: number; output?: number } } { return {}; }
}

export class CodexAdapter extends LocalCliAdapter {
  constructor(command: string, private readonly sandbox = 'read-only', model?: string) { super('codex', command, model); }
  // `exec -- <prompt>` makes codex wait on stdin instead of reading the prompt, and it refuses to run outside
  // a trusted git repo. The prompt is positional, and the sandbox is stated so nothing waits for approval.
  protected argumentsFor(prompt: string, resumeId?: string): string[] {
    const head = resumeId ? ['exec', 'resume', resumeId] : ['exec'];
    return [...head, '--json', '--sandbox', this.sandbox, '--skip-git-repo-check',
            ...(this.model ? ['-m', this.model] : []), prompt];
  }
  protected authArguments(): string[] { return ['login', 'status']; }

  /** codex --json prints one event per line: thread.started carries the id, turn.completed the usage. */
  protected readMeta(out: string): { sessionId?: string; tokens?: { input?: number; output?: number } } {
    let sessionId: string | undefined;
    let tokens: { input?: number; output?: number } | undefined;
    for (const line of out.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const e = JSON.parse(s) as { type?: string; thread_id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        if (e.type === 'thread.started' && e.thread_id) sessionId = e.thread_id;
        if (e.usage) tokens = { input: e.usage.input_tokens, output: e.usage.output_tokens };
      } catch { /* a partial line mid-stream: the next one will parse */ }
    }
    return { sessionId, tokens };
  }

  /** The assistant's words, with the event envelope taken off. */
  static answer(out: string): string { return CodexAdapter.streamText(out).trim(); }

  /** codex reports finished messages rather than tokens, so text lands a message at a time. */
  static streamText(raw: string): string {
    const parts: string[] = [];
    for (const e of jsonLines(raw)) {
      const o = e as { type?: string; item?: { type?: string; text?: string } };
      if (o.type === 'item.completed' && o.item?.type === 'agent_message' && o.item.text) parts.push(o.item.text);
    }
    return parts.join('\n');
  }
}
export class ClaudeAdapter extends LocalCliAdapter {
  constructor(command: string, model?: string) { super('claude', command, model); }
  // without --model the CLI picks its default, which on a Pro plan answers "requires usage credits"
  // stream-json gives the reply a token at a time, which is what makes the panel feel like a conversation
  // rather than a progress bar. --verbose is required alongside it.
  protected argumentsFor(prompt: string, resumeId?: string): string[] {
    return [...(this.model ? ['--model', this.model] : []),
            ...(resumeId ? ['--resume', resumeId] : []),
            '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', prompt];
  }

  protected readMeta(out: string): { sessionId?: string; tokens?: { input?: number; output?: number } } {
    let sessionId: string | undefined;
    let tokens: { input?: number; output?: number } | undefined;
    for (const e of jsonLines(out)) {
      const o = e as { session_id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (o.session_id) sessionId = o.session_id;
      if (o.usage) tokens = { input: o.usage.input_tokens, output: o.usage.output_tokens };
    }
    return { sessionId, tokens };
  }

  /** The words, gathered from the deltas, with the final result line as a fallback. */
  static answer(out: string): string {
    const streamed = ClaudeAdapter.streamText(out);
    if (streamed.trim()) return streamed.trim();
    for (const e of jsonLines(out)) {
      const o = e as { result?: string };
      if (typeof o.result === 'string') return o.result.trim();
    }
    return out.trim();
  }

  /** Display text inside one raw chunk, for painting the reply as it arrives. */
  static streamText(raw: string): string {
    let text = '';
    for (const e of jsonLines(raw)) {
      const o = e as { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
      if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && o.event.delta?.type === 'text_delta') {
        text += o.event.delta.text ?? '';
      }
    }
    return text;
  }
  protected authArguments(): string[] { return ['auth', 'status']; }
}

export function createAdapters(commands: Record<WorkerId, string>, codexSandbox = 'read-only',
                               models: Partial<Record<WorkerId, string>> = {}): Record<WorkerId, WorkerAdapter> {
  return { codex: new CodexAdapter(commands.codex, codexSandbox, models.codex),
           claude: new ClaudeAdapter(commands.claude, models.claude) };
}
