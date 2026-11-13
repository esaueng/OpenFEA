import type { KeyboardEvent } from "react";

/**
 * Keyboard support for a `role="radiogroup"` of `role="radio"` buttons, per the WAI-ARIA
 * radio group pattern: Right/Down move to the next option and Left/Up to the previous one
 * (wrapping), Home/End jump to the ends, and selection follows focus. Pair it with
 * `radioTabIndex` so Tab enters the group once, on the checked option.
 *
 * Usage: `<div role="radiogroup" onKeyDown={handleRadioGroupKeyDown}>`.
 */
export function nextRadioIndex(key: string, index: number, count: number): number | null {
  if (count <= 0 || index < 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function handleRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const group = event.currentTarget;
  const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
    (radio) => radio.closest('[role="radiogroup"]') === group && !(radio as HTMLButtonElement).disabled && radio.getAttribute("aria-disabled") !== "true"
  );
  const current = radios.findIndex((radio) => radio === event.target || radio.contains(event.target as Node));
  const next = nextRadioIndex(event.key, current, radios.length);
  if (next === null) return;
  event.preventDefault();
  const target = radios[next]!;
  target.focus();
  if (target.getAttribute("aria-checked") !== "true") target.click();
}

/** Roving tabindex: only the checked option is a Tab stop; arrows move within the group. */
export function radioTabIndex(checked: boolean): 0 | -1 {
  return checked ? 0 : -1;
}
