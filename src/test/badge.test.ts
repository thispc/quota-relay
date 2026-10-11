import test from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, meter, spareNote, tooltipTable, until, windowsText } from '../badge';

const now = Date.parse('2026-10-11T12:00:00Z');
const h = 3_600_000, d = 24 * h;

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
  assert.equal(levelOf({ fiveHour: 31, sevenDay: 60, sevenDayResetsAt: now + 3 * d }, now), 'ok');
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

test('well behind the clock on the week is spare: it will be lost at the reset', () => {
  // 5 of 7 days gone (71%), 30% used: 41 points behind
  const w = { fiveHour: 96, sevenDay: 70, sevenDayResetsAt: now + 2 * d };
  assert.equal(levelOf(w, now), 'spare');
  assert.match(spareNote(w, now)!, /30% of the week used with 71% of it gone/);
  // the same 30% used one day in (14% gone) is ahead of the clock, so just healthy
  assert.equal(levelOf({ fiveHour: 96, sevenDay: 70, sevenDayResetsAt: now + 6 * d }, now), 'ok');
});

test('an untouched subscription is spare', () => {
  assert.equal(levelOf({ fiveHour: 100, sevenDay: 100 }, now), 'spare', 'no reset time yet: the week has not started counting');
  assert.match(spareNote({ fiveHour: 100, sevenDay: 97, sevenDayResetsAt: now + 6 * d }, now)!, /barely touched/);
});

test('running low always wins over spare', () => {
  assert.equal(levelOf({ fiveHour: 10, sevenDay: 95, sevenDayResetsAt: now + d }, now), 'critical', 'the session is nearly out, whatever the week says');
  assert.equal(spareNote({ fiveHour: 10, sevenDay: 95, sevenDayResetsAt: now + d }, now), undefined);
});

test('with no weekly window, pace is judged on the 5-hour one', () => {
  assert.equal(levelOf({ fiveHour: 90, fiveHourResetsAt: now + h }, now), 'spare', '10% used with 80% of the window gone');
});
