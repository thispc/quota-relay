import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAntigravityQuotaPayload, readAntigravityUsage, resetAntigravityCache } from '../antigravity-usage';

const samplePayload = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      description: 'Model limits',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.95,
              reset_time: '2026-09-29T15:00:00Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.78,
              reset_time: '2026-09-22T20:00:00Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: '3p models',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1.0,
              reset_time: '2026-09-29T15:00:00Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.9,
              reset_time: '2026-09-22T20:00:00Z',
            },
          ],
        },
      ],
    },
  },
});

test('parses Antigravity quota payload into structured windows', () => {
  const usage = parseAntigravityQuotaPayload(samplePayload);
  assert.equal(usage.error, undefined);
  assert.equal(usage.groups.length, 2);

  // Primary should be Gemini 5-hour window
  assert.ok(usage.primary);
  assert.equal(usage.primary.window, '5h');
  assert.equal(usage.primary.remainingPercent, 78);
  assert.equal(usage.primary.usedPercent, 22);
  assert.equal(usage.primary.windowMinutes, 300);
  assert.equal(usage.primary.resetsAt, Date.parse('2026-09-22T20:00:00Z'));

  const geminiGroup = usage.groups[0];
  assert.equal(geminiGroup.name, 'Gemini Models');
  assert.equal(geminiGroup.weekly?.remainingPercent, 95);
  assert.equal(geminiGroup.weekly?.usedPercent, 5);
  assert.equal(geminiGroup.weekly?.windowMinutes, 10080);

  const thirdPartyGroup = usage.groups[1];
  assert.equal(thirdPartyGroup.name, 'Claude and GPT models');
  assert.equal(thirdPartyGroup.fiveHour?.remainingPercent, 90);
  assert.equal(thirdPartyGroup.fiveHour?.usedPercent, 10);
});

test('handles malformed Antigravity quota payload gracefully', () => {
  const usage = parseAntigravityQuotaPayload('not json');
  assert.ok(usage.error?.includes('Could not parse Antigravity quota payload'));
  assert.equal(usage.groups.length, 0);

  const emptyUsage = parseAntigravityQuotaPayload('{}');
  assert.ok(emptyUsage.error?.includes('Unexpected Antigravity quota response structure'));
});

test('reads Antigravity usage with mocks and sqlite stats', () => {
  resetAntigravityCache();
  const usage = readAntigravityUsage({
    forceRefresh: true,
    runExec: () => samplePayload,
    runSqlite: () => '10\t150\n',
    dbExists: () => true,
    homeDir: '/mock/home',
  });

  assert.equal(usage.error, undefined);
  assert.equal(usage.primary?.usedPercent, 22);
  assert.equal(usage.conversationsCount, 10);
  assert.equal(usage.totalSteps, 150);
});
