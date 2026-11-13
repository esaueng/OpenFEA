import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { isTroikaTextModule, stripTroikaFallbackFontResolver, TROIKA_FALLBACK_FONT_STUB } from "../troikaFallbackFonts";

const require = createRequire(import.meta.url);
const troikaEsmPath = join(dirname(require.resolve("troika-three-text/package.json")), "dist/troika-three-text.esm.js");

describe("troika fallback font resolver stub", () => {
  test("removes the CDN font resolver from the installed troika build", () => {
    const upstream = readFileSync(troikaEsmPath, "utf8");
    expect(isTroikaTextModule(troikaEsmPath)).toBe(true);
    expect(upstream).toContain("cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver");

    const stripped = stripTroikaFallbackFontResolver(upstream);
    expect(stripped).toContain(TROIKA_FALLBACK_FONT_STUB);
    // The only other CDN mention is a commented-out debug loader the minifier drops.
    const executable = stripped.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(executable).not.toContain("cdn.jsdelivr.net");
    expect(executable).not.toMatch(/\bfetch\(/);
    // troika still wires the factory into its font resolver module.
    expect(stripped).toContain("init(createFontResolver, fontParser, unicodeFontResolverClientFactory)");
  });

  test("the stub fails loudly instead of fetching", async () => {
    const factory = new Function(`${TROIKA_FALLBACK_FONT_STUB}; return unicodeFontResolverClientFactory;`)() as () => { getFontsForString: (text: string) => Promise<unknown> };
    await expect(factory().getFontsForString("σ")).rejects.toThrow(/disables troika's network fallback fonts/);
  });

  test("refuses to patch an unexpected troika build", () => {
    expect(() => stripTroikaFallbackFontResolver("export const Text = 1;")).toThrow(/changed shape/);
    expect(isTroikaTextModule("/x/node_modules/three/build/three.module.js")).toBe(false);
  });
});
