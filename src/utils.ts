/** Prefix a path with the Astro base URL */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

/** Link target for content data: site paths get the base prefix, full URLs
    (an event on another club's site) pass through untouched. */
export function href(link: string): string {
  return isExternal(link) ? link : asset(link);
}

export function isExternal(link: string): boolean {
  return /^https?:\/\//.test(link);
}

export interface EventItem {
  date: string;
  endDate?: string;
  title: string;
  description?: string;
  location?: string;
  startTime?: string;
  endTime?: string;
  type?: string;
  link?: string;
}

export const daysShort = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

export const months = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

export const monthsShort = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

export const typeLabels: Record<string, string> = {
  nmd: 'NHMD',
  expositie: 'Expositie',
  opendag: 'Open dag',
  beurs: 'Beurs',
  overig: 'Overig',
};

/** Local calendar day as YYYY-MM-DD, matching the format used in events.json. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Events that have not finished yet, soonest first.
 *
 * An event stays in the list for the whole of its own day (and, for a range,
 * through its endDate) and drops out the day after, so the head of the list is
 * always the next event. Dates are compared as YYYY-MM-DD strings rather than
 * Date objects: parsing "2026-09-12" yields UTC midnight, which lands on the
 * wrong side of a local midnight in negative UTC offsets and would retire an
 * event a day early.
 *
 * `today` is injectable so the rollover can be tested at a fixed date.
 */
export function upcomingEvents(events: EventItem[], limit?: number, today: Date = new Date()): EventItem[] {
  const cutoff = isoDay(today);
  const upcoming = events
    .filter(e => (e.endDate || e.date) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
  return limit === undefined ? upcoming : upcoming.slice(0, limit);
}

/** Compact date label: "12 sep", or "14–17 mei" for a range within one month. */
export function eventDateLabel(event: EventItem): string {
  const start = new Date(event.date);
  const end = event.endDate ? new Date(event.endDate) : null;
  if (!end || end.getTime() === start.getTime()) {
    return `${start.getDate()} ${monthsShort[start.getMonth()]}`;
  }
  if (end.getMonth() === start.getMonth()) {
    return `${start.getDate()}–${end.getDate()} ${monthsShort[start.getMonth()]}`;
  }
  return `${start.getDate()} ${monthsShort[start.getMonth()]} – ${end.getDate()} ${monthsShort[end.getMonth()]}`;
}

/** Full date for the "Wanneer" field: "8 november 2026, 10:00-15:00". */
export function eventWhen(event: EventItem): string {
  const start = new Date(event.date);
  const end = event.endDate ? new Date(event.endDate) : null;
  const day = (d: Date) => `${d.getDate()} ${months[d.getMonth()]}`;

  let when: string;
  if (!end || end.getTime() === start.getTime()) {
    when = `${day(start)} ${start.getFullYear()}`;
  } else if (end.getFullYear() === start.getFullYear() && end.getMonth() === start.getMonth()) {
    when = `${start.getDate()}–${day(end)} ${end.getFullYear()}`;
  } else {
    when = `${day(start)} – ${day(end)} ${end.getFullYear()}`;
  }

  const time = [event.startTime, event.endTime].filter(Boolean).join('–');
  return time ? `${when}, ${time}` : when;
}
