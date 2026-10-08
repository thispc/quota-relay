import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GeminiUsage {
  requests: number;
  totalTokens: number;
  lastModel?: string;
  updatedAt?: number;
  lastError?: string;
  error?: string;
}

/** Reads Gemini CLI's local chat telemetry without sending prompts or credentials anywhere. */
export function readGeminiUsage(root = join(homedir(), '.gemini', 'tmp')): GeminiUsage {
  if (!existsSync(root)) return { requests: 0, totalTokens: 0, error: 'Gemini CLI telemetry directory not found' };
  let requests = 0;
  let totalTokens = 0;
  let lastModel: string | undefined;
  let updatedAt: number | undefined;
  let lastError: string | undefined;
  for (const file of chatFiles(root)) {
    let lines: string[];
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          timestamp?: string;
          type?: string;
          model?: string;
          tokens?: { total?: number };
          error?: string;
          status?: string;
          message?: string;
        };
        const at = event.timestamp ? Date.parse(event.timestamp) : undefined;
        if (event.type === 'gemini' && event.tokens) {
          requests += 1;
          if (typeof event.tokens.total === 'number') totalTokens += event.tokens.total;
          if (event.model) lastModel = event.model;
          if (at) updatedAt = Math.max(updatedAt ?? 0, at);
        }
        const text = [event.error, event.message].filter(Boolean).join(' ');
        if (text && /quota|rate.?limit|resource.?exhausted|too many requests/i.test(text)) {
          lastError = text;
        }
        if (event.status && /quota|rate.?limit|resource.?exhausted/i.test(event.status)) lastError = event.status;
      } catch { /* Ignore partial JSONL writes. */ }
    }
  }
  return {
    requests,
    totalTokens,
    ...(lastModel ? { lastModel } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function chatFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...chatFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && path.includes(`${join('chats')}/`)) files.push(path);
  }
  return files;
}
