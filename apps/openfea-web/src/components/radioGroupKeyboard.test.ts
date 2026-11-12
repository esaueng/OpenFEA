import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KeyboardEvent } from "react";
import { describe, expect, test, vi } from "vitest";
import { handleRadioGroupKeyDown, nextRadioIndex, radioTabIndex } from "./radioGroupKeyboard";

/** The few DOM members the handler touches, without a DOM environment. */
function fakeGroup(checkedIndex: number, count = 3, disabled: number[] = []) {
  const group = { querySelectorAll: () => radios } as unknown as HTMLElement;
  const radios = Array.from({ length: count }, (_, index) => {
    const radio = {
      checked: index === checkedIndex,
      disabled: disabled.includes(index),
      focus: vi.fn(),
      click: vi.fn(() => {
        for (const other of radios) other.checked = other === radio;
      }),
      closest: () => group,
      contains: (node: unknown) => node === radio,
      getAttribute: (name: string) => (name === "aria-checked" ? String(radio.checked) : null)
    };
    return radio;
  });
  return { group, radios };
}

function press(group: HTMLElement, target: unknown, key: string, modifiers: Partial<Record<"altKey" | "ctrlKey" | "metaKey", boolean>> = {}) {
  const event = { key, target, currentTarget: group, preventDefault: vi.fn(), ...modifiers } as unknown as KeyboardEvent<HTMLElement>;
  handleRadioGroupKeyDown(event);
  return event;
}

describe("radio group keyboard", () => {
  test("moves with the arrows, wraps at the ends and jumps with Home/End", () => {
    expect(nextRadioIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextRadioIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextRadioIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextRadioIndex("ArrowUp", 1, 3)).toBe(0);
    expect(nextRadioIndex("Home", 2, 3)).toBe(0);
    expect(nextRadioIndex("End", 0, 3)).toBe(2);
    expect(nextRadioIndex("Tab", 0, 3)).toBeNull();
    expect(nextRadioIndex("ArrowRight", -1, 3)).toBeNull();
  });

  test("focuses and selects the next option, so selection follows focus", () => {
    const { group, radios } = fakeGroup(0);
    const event = press(group, radios[0], "ArrowRight");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(radios[1]!.focus).toHaveBeenCalled();
    expect(radios[1]!.click).toHaveBeenCalledTimes(1);
    expect(radios.map((radio) => radio.checked)).toEqual([false, true, false]);
  });

  test("skips disabled options and leaves modified keys to the browser", () => {
    const { group, radios } = fakeGroup(0, 3, [1]);
    press(group, radios[0], "ArrowRight");
    expect(radios[2]!.click).toHaveBeenCalled();
    const modified = press(group, radios[2], "ArrowLeft", { altKey: true });
    expect(modified.preventDefault).not.toHaveBeenCalled();
  });

  test("does not re-select the option that is already checked", () => {
    const { group, radios } = fakeGroup(0);
    press(group, radios[0], "Home");
    expect(radios[0]!.focus).toHaveBeenCalled();
    expect(radios[0]!.click).not.toHaveBeenCalled();
  });

  test("keeps one Tab stop per group", () => {
    expect(radioTabIndex(true)).toBe(0);
    expect(radioTabIndex(false)).toBe(-1);
  });

  test("wires the project menu's theme and unit groups", () => {
    const source = readFileSync(resolve(__dirname, "ProjectMenu.tsx"), "utf8");
    expect(source.match(/role="radiogroup"[^>]*onKeyDown=\{handleRadioGroupKeyDown\}/g)).toHaveLength(2);
    expect(source.match(/tabIndex=\{radioTabIndex\(/g)).toHaveLength(4);
  });
});
