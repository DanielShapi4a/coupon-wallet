import { describe, expect, it } from 'vitest';
import { endOfDayInIsrael, formatShekels, maskDate, parseShekels, uuidV4 } from './input.ts';

describe('maskDate', () => {
  it('adds the dashes as the digits arrive, and never leaves a trailing dash', () => {
    expect(['2', '20', '201', '2011', '20112', '20112026'].map(maskDate)).toEqual([
      '2',
      '20',
      '20-1',
      '20-11',
      '20-11-2',
      '20-11-2026',
    ]);
  });
  it('drops anything that is not a digit, and stops at eight digits', () => {
    expect(maskDate('20/11/2026')).toBe('20-11-2026');
    expect(maskDate('20-11-20269')).toBe('20-11-2026');
    expect(maskDate('')).toBe('');
  });
  it('lets a deleted digit stay deleted', () => {
    expect(maskDate('20-1')).toBe('20-1');
  });
});

describe('uuidV4', () => {
  it('formats 16 random bytes as a version 4 UUID', () => {
    const id = uuidV4(new Uint8Array(16).fill(0xff));
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('needs exactly 16 bytes', () => {
    expect(() => uuidV4(new Uint8Array(15))).toThrow();
  });
});

describe('parseShekels / formatShekels', () => {
  it('converts shekels to whole agorot', () => {
    expect(parseShekels('100')).toBe(10_000);
    expect(parseShekels('100.5')).toBe(10_050);
    expect(parseShekels('₪1,234.50')).toBe(123_450);
    expect(parseShekels('0.05')).toBe(5);
  });

  it('rejects what is not an amount', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1e3', '12345678']) expect(parseShekels(bad)).toBeNull();
  });

  it('formats agorot as shekels', () => {
    expect(formatShekels(10_000)).toBe('₪100');
    expect(formatShekels(65_550)).toBe('₪655.50');
  });
});

describe('endOfDayInIsrael', () => {
  it('uses winter time (+02:00) and summer time (+03:00)', () => {
    expect(endOfDayInIsrael('2026-12-31')).toBe('2026-12-31T23:59:59+02:00');
    expect(endOfDayInIsrael('2026-07-15')).toBe('2026-07-15T23:59:59+03:00');
  });

  it('rejects dates that do not exist or are not YYYY-MM-DD', () => {
    for (const bad of ['2026-02-30', '31/12/2026', '2026-13-01', '']) expect(endOfDayInIsrael(bad)).toBeNull();
  });
});
