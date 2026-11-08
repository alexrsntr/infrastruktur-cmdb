import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export const DATE_FORMAT = 'DD.MM.YYYY';
export const DATE_TIME_FORMAT = 'DD.MM.YYYY HH:mm';

export function fmtDate(v: string | null | undefined): string {
  return v ? dayjs(v).format(DATE_FORMAT) : '–';
}

export function fmtDateTime(v: string | null | undefined): string {
  return v ? dayjs(v).format(DATE_TIME_FORMAT) : '–';
}

export function fromNow(v: string | null | undefined): string {
  return v ? dayjs(v).fromNow() : '–';
}

export function daysUntil(v: string | null | undefined): number | null {
  if (!v) return null;
  return dayjs(v).startOf('day').diff(dayjs().startOf('day'), 'day');
}

export function dash(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/** Humanise audit field names like "attributes.port_count" */
export function fieldLabel(key: string): string {
  const k = key.replace(/^attributes\./, '');
  return k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
