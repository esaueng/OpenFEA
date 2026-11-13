/**
 * Below this magnitude three fixed decimals no longer guarantee three
 * significant digits (0.00143 would print as "0.001"), so significant figures
 * take over.
 */
const SMALL_MAGNITUDE_FLOOR = 0.1;
/** Below this magnitude, significant-figure decimals stop being readable. */
const EXPONENT_MAGNITUDE_FLOOR = 1e-6;
export const SIGNIFICANT_DIGITS = 4;

/**
 * The one display formatter for converted quantities.
 *
 * Precision adapts to magnitude instead of rounding the number itself, and
 * every tier keeps at least three significant digits. That matters at the
 * bottom of the range: a 0.001 mm deflection is 0.00003937 in, and any fixed
 * three-decimal rendering prints a real, load-bearing result as "0". The
 * 2026-09 interaction review found the same collapse one tier up — a 0.00143 mm
 * peak displacement rendered as "0.001 mm", a 30% error in a headline number —
 * which is why fixed decimals now stop at 0.1 rather than 0.001. Below the
 * exponent floor the value switches to exponent notation rather than growing a
 * run of leading zeros.
 *
 * Rounding happens here, at the string boundary, and nowhere upstream — see
 * `resultFieldForUnits` for why rounding converted *values* is destructive.
 */
export function formatDisplayNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  if (magnitude >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (magnitude >= 10) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (magnitude >= SMALL_MAGNITUDE_FLOOR) return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  if (magnitude >= EXPONENT_MAGNITUDE_FLOOR) return value.toLocaleString(undefined, { maximumSignificantDigits: SIGNIFICANT_DIGITS });
  return Number(value.toPrecision(SIGNIFICANT_DIGITS)).toExponential();
}
