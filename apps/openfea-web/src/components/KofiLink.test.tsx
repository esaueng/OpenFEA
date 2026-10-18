import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { COFFEE_ANIMATION_REPLAY_DELAY_MS, KofiLink, coffeeAnimationReplayDelayMs } from "./KofiLink";

const kofiSource = readFileSync(resolve(__dirname, "KofiLink.tsx"), "utf8");

// Strip tags until nothing changes: one pass can leave a partial tag such as "<script"
// behind (CodeQL js/incomplete-multi-character-sanitization).
function textContent(html: string) {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text;
}

describe("KofiLink", () => {
  test("renders decorative coffee animation elements and wave text without changing link copy", () => {
    const html = renderToStaticMarkup(<KofiLink />);

    expect(html).toContain('href="https://ko-fi.com/esau"');
    expect(html).toContain('class="donate-link"');
    expect(html).toContain('class="coffee-mark"');
    expect(html).toContain('class="coffee-steam coffee-steam-one"');
    expect(html).toContain('class="coffee-steam coffee-steam-two"');
    expect(html).toContain('class="coffee-sparkle"');
    expect(html).toContain('class="coffee-label"');
    expect(html).toContain('class="coffee-letter"');
    expect(html).toContain("--coffee-letter-index:0");
    expect(html).toContain("--coffee-letter-index:14");
    expect(textContent(html)).toContain("Buy me a coffee");
  });

  test("wires hover to play the coffee animation once", () => {
    expect(kofiSource).toContain("function runCoffeeAnimation()");
    expect(kofiSource).toContain("onMouseEnter={runCoffeeAnimation}");
    expect(kofiSource).toContain("window.clearTimeout(animationTimeoutRef.current)");
  });

  test("bounds the randomized coffee animation replay delay", () => {
    expect(COFFEE_ANIMATION_REPLAY_DELAY_MS).toEqual({ min: 18000, max: 45000 });
    expect(coffeeAnimationReplayDelayMs(0)).toBe(18000);
    expect(coffeeAnimationReplayDelayMs(0.5)).toBe(31500);
    expect(coffeeAnimationReplayDelayMs(1)).toBe(45000);
    expect(coffeeAnimationReplayDelayMs(-1)).toBe(18000);
    expect(coffeeAnimationReplayDelayMs(2)).toBe(45000);
  });
});
