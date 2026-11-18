// Decision 035, layer 2 (updated 2026-11-18): the silent passkey check.
// A passkey created moments ago is not yet visible to the check (phone test), so one "missing" answer
// is not enough: missing is reported only when the passkey is still missing at least 10 minutes after
// it was first found missing. Until then the result is "unknown", and no banner is shown.

export const MISSING_CONFIRM_MS = 10 * 60 * 1000;

export type PasskeyCheck = 'present' | 'missing' | 'unknown';

/**
 * One check's answer, given when the passkey was first found missing (null: not missing so far).
 * Returns the result to show and the new `missingSince` to keep. A new passkey resets it to null.
 * ponytail: wall-clock time; changing the phone's clock can shorten or stretch the 10 minutes.
 */
export function confirmPasskeyCheck(
  found: boolean,
  missingSince: number | null,
  now: number,
): { result: PasskeyCheck; missingSince: number | null } {
  if (found) return { result: 'present', missingSince: null };
  if (missingSince === null) return { result: 'unknown', missingSince: now };
  return { result: now - missingSince >= MISSING_CONFIRM_MS ? 'missing' : 'unknown', missingSince };
}
