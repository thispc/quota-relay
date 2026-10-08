import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsageRows } from '../codex-usage';

test('aggregates Codex token usage rows and keeps the latest model', () => {
  const usage = parseCodexUsageRows([
    { ts: 10, body: 'turn model=gpt-5.6-sol post sampling token usage total_usage_tokens=120' },
    { ts: 20, body: 'turn model=gpt-5.6-sol post sampling token usage total_usage_tokens=80' },
    { ts: 30, body: 'not a usage row' },
  ]);
  assert.deepEqual(usage, { requests: 2, totalTokens: 200, lastModel: 'gpt-5.6-sol', updatedAt: 20_000 });
});

test('returns an empty total when no Codex usage rows exist', () => {
  assert.deepEqual(parseCodexUsageRows([]), { requests: 0, totalTokens: 0 });
});
