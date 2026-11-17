// Small conversions for what a person types into the app.

/** A UUID v4 from 16 random bytes (the caller supplies them: libsodium on the phone). */
export function uuidV4(random: Uint8Array): string {
  if (random.length !== 16) throw new Error('A UUID needs 16 random bytes');
  const b = Uint8Array.from(random);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "100", "100.5" or "1,234.50" shekels to whole agorot. Null when it is not an amount. */
export function parseShekels(text: string): number | null {
  const clean = text.replace(/[₪,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export const formatShekels = (agorot: number) =>
  `₪${(agorot / 100).toLocaleString('en-US', { minimumFractionDigits: agorot % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/**
 * A validity date with no time ends at the end of that day in Israel (domain model).
 * "2026-12-31" becomes 23:59:59 on that day in Asia/Jerusalem, in summer time (+03:00) or winter time (+02:00).
 * Null when the date is not a real YYYY-MM-DD date.
 */
export function endOfDayInIsrael(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null; // e.g. 2026-02-30
  for (const offset of ['+03:00', '+02:00']) {
    const iso = `${date}T23:59:59${offset}`;
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(iso),
    );
    if (hour === '23') return iso;
  }
  return `${date}T23:59:59+02:00`;
}
