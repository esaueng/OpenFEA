import type { PluginOption } from "vite";

// troika-three-text (drei <Text>) embeds unicode-font-resolver, which fetches
// font indexes and font files from cdn.jsdelivr.net for any glyph the label's
// font lacks. OpenFEA keeps every scene label inside the bundled Plex face
// (src/components/SceneLabelText.tsx), so the resolver is dead code that would
// only ever make a network request the local-first app must not make. Replace
// it at build time with a stub that fails loudly instead: no CDN URL ships in
// the bundle, and ~2.5 kB gzip of unreachable code is dropped.
//
// Dev pre-bundles troika outside the plugin pipeline, so `pnpm dev` keeps the
// upstream resolver; SceneLabelText's glyph filtering still keeps it idle.

const FACTORY_PATTERN = /function unicodeFontResolverClientFactory\(\)\{[^\n]*\n/g;
// Shape check only (not URL validation): the factory being replaced must still be the
// resolver that loads its data from the lojjic/unicode-font-resolver CDN package.
const RESOLVER_DATA_PACKAGE = "lojjic/unicode-font-resolver@";

export const TROIKA_FALLBACK_FONT_STUB =
  "function unicodeFontResolverClientFactory(){return{getFontsForString:function(){return Promise.reject(new Error(" +
  "\"OpenFEA disables troika's network fallback fonts; keep scene label text inside the bundled face (SceneLabelText).\"))}}}\n";

export function isTroikaTextModule(id: string): boolean {
  return id.split("?", 1)[0]!.replaceAll("\\", "/").endsWith("/troika-three-text/dist/troika-three-text.esm.js");
}

export function stripTroikaFallbackFontResolver(code: string): string {
  const matches = code.match(FACTORY_PATTERN) ?? [];
  if (matches.length !== 1 || !matches[0]!.includes(RESOLVER_DATA_PACKAGE)) {
    throw new Error("troika-three-text's bundled unicode-font-resolver changed shape; review its network fallback before upgrading.");
  }
  return code.replace(FACTORY_PATTERN, TROIKA_FALLBACK_FONT_STUB);
}

export function troikaFallbackFonts(): PluginOption {
  return {
    name: "openfea:troika-no-network-fallback-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!isTroikaTextModule(id)) return null;
      return { code: stripTroikaFallbackFontResolver(code), map: null };
    }
  };
}
