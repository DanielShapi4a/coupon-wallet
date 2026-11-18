import { describe, expect, it } from 'vitest';
import { confirmPasskeyCheck, MISSING_CONFIRM_MS } from './passkey-check.ts';

describe('confirmPasskeyCheck', () => {
  const t0 = Date.parse('2026-11-18T10:00:00Z');

  it('reports present, and forgets any earlier miss', () => {
    expect(confirmPasskeyCheck(true, null, t0)).toEqual({ result: 'present', missingSince: null });
    expect(confirmPasskeyCheck(true, t0, t0 + MISSING_CONFIRM_MS)).toEqual({ result: 'present', missingSince: null });
  });

  it('does not report missing on the first miss, as right after creating a passkey', () => {
    expect(confirmPasskeyCheck(false, null, t0)).toEqual({ result: 'unknown', missingSince: t0 });
  });

  it('keeps it unknown while the 10 minutes have not passed, from the first miss', () => {
    expect(confirmPasskeyCheck(false, t0, t0 + MISSING_CONFIRM_MS - 1)).toEqual({ result: 'unknown', missingSince: t0 });
  });

  it('reports missing when the passkey is still missing 10 minutes after the first miss', () => {
    expect(confirmPasskeyCheck(false, t0, t0 + MISSING_CONFIRM_MS)).toEqual({ result: 'missing', missingSince: t0 });
  });
});
