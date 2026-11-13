import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/* WCAG contrast for the colour tokens, computed from tokens.css itself so a token edit
   that drops a pair below its floor fails here rather than in an audit. */

const tokens = readFileSync(resolve(__dirname, "tokens.css"), "utf8").replace(/\r\n/g, "\n");

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = tokens.match(new RegExp(`^${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`, "m"))?.groups?.body;
  if (!body) throw new Error(`Missing ${selector} block`);
  return body;
}

const darkBlock = block(":root");
const lightBlock = block(".theme-light");

type Theme = "dark" | "light";

function token(theme: Theme, name: string): string {
  // The light theme only overrides what it changes; everything else is inherited from :root.
  const sources = theme === "light" ? [lightBlock, darkBlock] : [darkBlock];
  for (const source of sources) {
    const value = source.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))?.[1];
    if (value) return value;
  }
  throw new Error(`Missing ${theme} token ${name}`);
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

/** `color-mix(in srgb, fg alpha%, bg)`, i.e. a translucent tint composited on a ground. */
function tint(foreground: string, alpha: number, background: string): string {
  const fg = channels(foreground);
  const bg = channels(background);
  return `#${fg.map((channel, index) => Math.round(channel * alpha + bg[index]! * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

const THEMES: Theme[] = ["dark", "light"];
const GROUNDS = ["--color-bg", "--color-surface", "--color-surface-2", "--color-surface-hover"];

describe("design token contrast", () => {
  test("form-control borders reach 3:1 against every ground (WCAG 1.4.11)", () => {
    for (const theme of THEMES) {
      for (const ground of GROUNDS) {
        expect(contrastRatio(token(theme, "--color-border-input"), token(theme, ground)), `${theme} input border on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("keeps decorative dividers on their own, quieter token", () => {
    // --color-border draws ~94 card edges and dividers; darkening it to 3:1 would have
    // turned every one of them into a hard rule. Only form controls take the input token.
    for (const theme of THEMES) {
      expect(token(theme, "--color-border-input")).not.toBe(token(theme, "--color-border"));
      expect(contrastRatio(token(theme, "--color-border"), token(theme, "--color-surface"))).toBeLessThan(3);
    }
    expect(tokens).toMatch(/input, select, textarea \{[^}]*border:\s*var\(--border-input\);/);
    expect(tokens).toMatch(/--border-input:\s*1px solid var\(--color-border-input\);/);
  });

  test("status and body text reach 4.5:1 on every ground", () => {
    const textTokens = ["--color-text", "--color-text-muted", "--color-text-subtle", "--color-accent", "--color-warning", "--color-error", "--color-success"];
    for (const theme of THEMES) {
      for (const name of textTokens) {
        for (const ground of GROUNDS) {
          expect(contrastRatio(token(theme, name), token(theme, ground)), `${theme} ${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("error and success text stay legible on their own 12% tints", () => {
    // Badges and notices set the status colour on a 12% wash of itself
    // (.validation-pass-badge, .workspace-notice.error, .text-button.danger-text:hover).
    // Every ground, hover included: a hovered danger button tints the hover surface.
    for (const theme of THEMES) {
      for (const name of ["--color-error", "--color-success"]) {
        const ink = token(theme, name);
        for (const ground of GROUNDS) {
          expect(contrastRatio(ink, tint(ink, 0.12, token(theme, ground))), `${theme} ${name} on its tint over ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test("light subtle text and error tint clear 4.5:1 on the hover surface", () => {
    // The two pairs an earlier review measured below the floor (4.38:1 and 4.31:1).
    const hover = token("light", "--color-surface-hover");
    const error = token("light", "--color-error");
    expect(contrastRatio(token("light", "--color-text-subtle"), hover)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(error, tint(error, 0.12, hover))).toBeGreaterThanOrEqual(4.5);
    // Subtle stays a step quieter than muted rather than collapsing onto it.
    expect(token("light", "--color-text-subtle")).not.toBe(token("light", "--color-text-muted"));
  });

  test("destructive buttons keep white text above 4.5:1", () => {
    for (const theme of THEMES) {
      expect(contrastRatio("#ffffff", token(theme, "--color-error-fill")), theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("restores a solid 2px focus ring on form controls", () => {
    // `input:focus { outline: none }` used to override :focus-visible and leave only a
    // 12%-alpha halo around a focused field.
    expect(tokens).not.toMatch(/input:focus, select:focus, textarea:focus \{[^}]*outline:\s*none/);
    expect(tokens).toMatch(/input:focus-visible,\nselect:focus-visible,\ntextarea:focus-visible \{\s*outline:\s*2px solid var\(--color-accent\);/);
    for (const theme of THEMES) {
      for (const ground of GROUNDS) {
        expect(contrastRatio(token(theme, "--color-accent"), token(theme, ground)), `${theme} focus ring on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
