import test from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, meter, tooltipTable, until, windowsText } from '../badge';

const now = Date.parse('2026-10-11T12:00:00Z');
const h = 3_600_000;

test('both windows are always named, in the same order', () => {
  assert.equal(windowsText({ fiveHour: 86, sevenDay: 61 }, now), '5h 86% · 7d 61%');
  assert.equal(windowsText({ sevenDay: 61 }, now), '7d 61%', 'a provider with one window shows that one, still named');
  assert.equal(windowsText(undefined, now), '—');
});

test('a window running low says when it comes back', () => {
  assert.equal(windowsText({ fiveHour: 86, sevenDay: 3, sevenDayResetsAt: now + 52 * h }, now), '5h 86% · 7d 3% ↻2d');
  assert.equal(windowsText({ fiveHour: 12, fiveHourResetsAt: now + 0.7 * h, sevenDay: 80, sevenDayResetsAt: now + 90 * h }, now),
               '5h 12% ↻42m · 7d 80%', 'only the low one; the other reset is not the question yet');
  assert.equal(windowsText({ fiveHour: 12, fiveHourResetsAt: now - h }, now), '5h 12%', 'a reset time in the past is not shown');
});

test('percentages are whole and within 0 to 100', () => {
  assert.equal(windowsText({ fiveHour: 46.6, sevenDay: -4 }, now), '5h 47% · 7d 0%');
});

test('the tighter window decides the colour', () => {
  assert.equal(levelOf({ fiveHour: 90, sevenDay: 3 }), 'critical');
  assert.equal(levelOf({ fiveHour: 25, sevenDay: 90 }), 'low');
  assert.equal(levelOf({ fiveHour: 31, sevenDay: 90 }), 'ok');
  assert.equal(levelOf({}), 'unknown');
});

test('durations read the way a person says them', () => {
  assert.equal(until(now + 42 * 60_000, now), '42m');
  assert.equal(until(now + 3 * h, now), '3h');
  assert.equal(until(now + 3.5 * h, now), '3h 30m');
  assert.equal(until(now + 52 * h, now), '2d 4h');
});

test('the meter has ten steps', () => {
  assert.equal(meter(100), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(meter(34), '▰▰▰▱▱▱▱▱▱▱');
  assert.equal(meter(0), '▱▱▱▱▱▱▱▱▱▱');
});

test('every tooltip has the same two columns, and marks the active row', () => {
  const md = tooltipTable('Claude', [
    { name: 'backup', active: true, windows: { fiveHour: 86, sevenDay: 3 } },
    { name: 'og', note: '⚠ signed out' }], ['Auto-switch is on.'], now);
  assert.match(md, /\| \| 5-hour \| Week \|/);
  assert.match(md, /\| ● backup \|.*\*\*86%\*\*.*\*\*3%\*\*/);
  assert.match(md, /\| og \| ⚠ signed out \| \|/);
  assert.match(md, /percent left/);
});
