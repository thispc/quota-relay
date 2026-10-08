import * as vscode from 'vscode';
import process from 'node:process';
import { WorkerManager } from './manager';
import { Conversation, StreamChunk, WorkerId, WorkerSelection } from './models';
import { newConversation, addTurn, promptFor, recordAnswer } from './conversation';
import { answerOf } from './chat';
import { ClaudeAdapter, CodexAdapter } from './adapters';
import { TurnQueue } from './queue';

/** Display text inside a raw chunk, for painting a reply while it is still arriving. */
function liveText(worker: WorkerId, raw: string): string {
  return worker === 'codex' ? CodexAdapter.streamText(raw) : ClaudeAdapter.streamText(raw);
}

/**
 * The chat panel: a conversation you can keep typing into.
 *
 * Messages sent while a reply is in flight are queued rather than dropped or run at once, in the order typed,
 * and the queue is visible so nothing is lost silently (Pulkit, 20 Sep 2026: "chatting, queuing messages,
 * exactly like that"). One worker runs at a time; the conversation moves provider when a window is spent.
 */
export class ChatPanel {
  static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly queue: TurnQueue;
  private disposed = false;

  static show(ctx: vscode.ExtensionContext, manager: WorkerManager, models: Record<string, string | undefined>,
              timeoutMs: number): ChatPanel {
    if (ChatPanel.current && !ChatPanel.current.disposed) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.current;
    }
    ChatPanel.current = new ChatPanel(ctx, manager, models, timeoutMs);
    return ChatPanel.current;
  }

  private constructor(private readonly ctx: vscode.ExtensionContext, private readonly manager: WorkerManager,
                      private readonly models: Record<string, string | undefined>, private readonly timeoutMs: number) {
    this.queue = new TurnQueue(
      text => this.turn(text),
      waiting => this.post({ type: 'queue', items: waiting }),
      error => this.post({ type: 'error', text: String(error) }),
      () => this.post({ type: 'idle' }));
    this.panel = vscode.window.createWebviewPanel('localCliWorkers.chat', 'Workers Chat', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { this.disposed = true; ChatPanel.current = undefined; });
    this.panel.webview.onDidReceiveMessage((m: { type: string; text?: string }) => {
      if (m.type === 'send' && m.text?.trim()) this.enqueue(m.text.trim());
      if (m.type === 'new') this.reset();
      if (m.type === 'cancel') this.cancel();
      if (m.type === 'ready') this.restore();
    });
    this.manager.events.on('limited', ({ worker, until, next }: { worker: WorkerId; until: number; next?: WorkerId }) => {
      const back = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.post({ type: 'notice', text: next
        ? `${worker} is out of limit until ${back}. Switching to ${this.label(next)}.`
        : `${worker} is out of limit until ${back}, and nothing else is free.` });
    });
  }

  private label(w: WorkerId): string { return this.models[w] ? `${w} (${this.models[w]})` : w; }
  private post(m: unknown): void { if (!this.disposed) void this.panel.webview.postMessage(m); }
  private get conv(): Conversation { return this.ctx.workspaceState.get<Conversation>('localCliWorkers.conversation') ?? newConversation(); }
  private async save(c: Conversation): Promise<void> { await this.ctx.workspaceState.update('localCliWorkers.conversation', c); }

  private restore(): void {
    const c = this.conv;
    this.post({ type: 'restore', turns: c.turns.map(t => ({ role: t.role, text: t.text, worker: t.worker })) });
  }

  private async reset(): Promise<void> {
    await this.ctx.workspaceState.update('localCliWorkers.conversation', undefined);
    this.queue.clear();
    this.post({ type: 'reset' });
  }

  private cancel(): void {
    this.queue.clear();
    this.manager.cancelActive();
  }

  private enqueue(text: string): void {
    this.post({ type: 'user', text });
    this.queue.push(text);
  }

  private async turn(text: string): Promise<void> {
    const conv = this.conv;
    addTurn(conv, { role: 'user', text });
    const planned = this.manager.preferredWorker() ?? 'claude';
    const plan = promptFor(conv, planned, text);
    this.post({ type: 'start', worker: this.label(planned), replayed: plan.replayed });

    let painted = '';
    const onChunk = (c: StreamChunk) => {
      const add = liveText(planned, c.text);
      if (add) { painted += add; this.post({ type: 'delta', text: add }); }
    };
    const result = await this.manager.run({ prompt: plan.prompt, cwd: this.cwd(), worker: 'auto' as WorkerSelection,
                                            timeoutMs: this.timeoutMs, resumeId: plan.resumeId }, onChunk);

    // quota may have moved the turn to a worker that never saw the transcript: send it again, with it
    let final = result;
    if (result.worker !== planned && !plan.replayed && conv.turns.length > 1) {
      const second = promptFor(conv, result.worker, text);
      if (second.replayed) {
        this.post({ type: 'restart', worker: this.label(result.worker) });
        painted = '';
        final = await this.manager.run({ prompt: second.prompt, cwd: this.cwd(), worker: result.worker,
                                         timeoutMs: this.timeoutMs }, c => {
          const add = liveText(result.worker, c.text);
          if (add) { painted += add; this.post({ type: 'delta', text: add }); }
        });
      }
    }
    const answer = answerOf(final.worker, final.output) || painted;
    recordAnswer(conv, final.worker, final, answer);
    await this.save(conv);
    this.post({ type: 'done', worker: this.label(final.worker), text: answer,
                tokens: final.tokens, exitCode: final.exitCode });
  }

  private cwd(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(); }

  private html(): string {
    const w = this.panel.webview;
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'chat.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'chat.js'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head>
<body>
  <div id="log" role="log" aria-live="polite"></div>
  <div id="queue" hidden></div>
  <form id="bar">
    <textarea id="input" rows="1" placeholder="Message. Enter to send, Shift+Enter for a new line." aria-label="Message"></textarea>
    <button id="send" type="submit">Send</button>
    <button id="stop" type="button" hidden>Stop</button>
    <button id="new" type="button" title="Start a new conversation">New</button>
  </form>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
