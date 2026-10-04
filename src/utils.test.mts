import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingEvents, eventDateLabel, href, isExternal, type EventItem } from './utils.ts';

const EVENTS: EventItem[] = [
  { date: '2026-05-14', endDate: '2026-05-17', title: 'Excursie Darmstadt' },
  { date: '2026-09-12', title: 'Open Monumentendag' },
  { date: '2026-10-25', title: 'Open Dag MSA' },
];

const on = (day: string) => upcomingEvents(EVENTS, undefined, new Date(`${day}T12:00:00`));
const nextOn = (day: string) => on(day)[0]?.title ?? null;

test('the head of the list is the next event', () => {
  assert.equal(nextOn('2026-01-01'), 'Excursie Darmstadt');
});

test('an event still shows on its own day', () => {
  assert.equal(nextOn('2026-09-12'), 'Open Monumentendag');
});

test('it rolls over to the next event the day after', () => {
  assert.equal(nextOn('2026-09-11'), 'Open Monumentendag');
  assert.equal(nextOn('2026-09-12'), 'Open Monumentendag');
  assert.equal(nextOn('2026-09-13'), 'Open Dag MSA');
});

test('a multi-day event survives until its endDate passes', () => {
  assert.equal(nextOn('2026-05-14'), 'Excursie Darmstadt', 'first day');
  assert.equal(nextOn('2026-05-16'), 'Excursie Darmstadt', 'middle day');
  assert.equal(nextOn('2026-05-17'), 'Excursie Darmstadt', 'last day');
  assert.equal(nextOn('2026-05-18'), 'Open Monumentendag', 'day after');
});

test('the list empties once everything is past, rather than showing a stale event', () => {
  assert.deepEqual(on('2026-10-26'), []);
});

test('rollover holds in a negative UTC offset', () => {
  // Parsing "2026-09-12" gives UTC midnight; in UTC-8 that is still 11 Sept
  // locally, which used to retire the event a day early.
  const prev = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(nextOn('2026-09-12'), 'Open Monumentendag');
    assert.equal(nextOn('2026-09-13'), 'Open Dag MSA');
  } finally {
    process.env.TZ = prev;
  }
});

test('date labels cover single days, ranges, and cross-month ranges', () => {
  assert.equal(eventDateLabel({ date: '2026-09-12', title: '' }), '12 sep');
  assert.equal(eventDateLabel({ date: '2026-05-14', endDate: '2026-05-17', title: '' }), '14–17 mei');
  assert.equal(eventDateLabel({ date: '2026-05-30', endDate: '2026-06-02', title: '' }), '30 mei – 2 jun');
});

test('an event link to another site is left as it is', () => {
  const url = 'https://www.modelspoorclubalkmaar.nl/activiteiten/open-dag';
  assert.equal(isExternal(url), true);
  assert.equal(href(url), url);
});

test('a site path is not mistaken for an external link', () => {
  assert.equal(isExternal('/bezoek'), false);
  assert.equal(isExternal('/nieuws/https-uitleg'), false);
});
