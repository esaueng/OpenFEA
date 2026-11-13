/**
 * Code points that ibm-plex-sans-latin-500-normal.woff (the only face scene
 * labels use) maps to a glyph. sceneLabelText.test.ts re-reads the font's cmap
 * and fails if this drifts.
 */
const SCENE_LABEL_FONT_GLYPHS = /^[\x20-\x7e\xa0-\xff\u0131\u0152\u0153\u02bb\u02bc\u02c6\u02da\u02dc\u0300\u0301\u0303\u0304\u0308\u0309\u0323\u2002\u2009\u200b\u2013\u2014\u2018-\u201a\u201c-\u201e\u2022\u2026\u2032\u2033\u2039\u203a\u2044\u20ac\u2122\u2191\u2193\u2212\u2215\ufeff\ufffd]$/;

export function sceneLabelFontCovers(codePoint: number): boolean {
  return codePoint <= 0xffff && SCENE_LABEL_FONT_GLYPHS.test(String.fromCharCode(codePoint));
}

const SUPERSCRIPT_RUN = /[\u2070\u00b9\u00b2\u00b3\u2074-\u207e]+/gu;
const READABLE_SUBSTITUTES: Record<string, string> = {
  "\u03bc": "\u00b5", // Greek mu -> micro sign (micro-units)
  "\u2192": "->",
  "\u2248": "~",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2260": "!="
};
const MISSING_GLYPH = "?";

/**
 * troika-three-text resolves any character its font lacks through
 * unicode-font-resolver, which fetches index and font files from
 * cdn.jsdelivr.net at runtime. That breaks the app's offline/no-egress promise
 * and logs an uncaught "Failed to fetch" when the host is blocked. Rewrite
 * label text so every character is one the bundled face covers: readable
 * ASCII stand-ins for common symbols (superscript exponents become "^n"),
 * compatibility forms (subscript digits) via NFKC, and "?" for the rest.
 * Leading whitespace the face lacks (newline, tab) is dropped, because troika
 * only carries whitespace forward from a preceding character.
 */
export function sceneLabelText(text: string): string {
  const composed = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  let out = "";
  let index = 0;
  for (const match of composed.matchAll(SUPERSCRIPT_RUN)) {
    out += coveredText(composed.slice(index, match.index), out.length === 0);
    const run = match[0];
    // Latin-1 already holds the superscript 1-3 glyphs; keep a run made only of those.
    out += [...run].every((char) => sceneLabelFontCovers(char.codePointAt(0)!))
      ? run
      : `^${coveredText(run.normalize("NFKC").replace(/−/g, "-"), false)}`;
    index = match.index + run.length;
  }
  return out + coveredText(composed.slice(index), out.length === 0);
}

function coveredText(segment: string, atStart: boolean): string {
  let out = "";
  for (const char of segment) {
    const codePoint = char.codePointAt(0)!;
    if (sceneLabelFontCovers(codePoint)) {
      out += char;
    } else if (/\s/u.test(char)) {
      // troika carries whitespace forward from the previous character; only a
      // leading one would reach the fallback resolver.
      if (!(atStart && out.length === 0)) out += char;
    } else {
      out += substituteFor(char);
    }
  }
  return out;
}

function substituteFor(char: string): string {
  const readable = READABLE_SUBSTITUTES[char];
  if (readable !== undefined) return readable;
  // Compatibility form (subscript digits), else the base letter without accents.
  for (const form of ["NFKC", "NFD"]) {
    const candidate = char.normalize(form).replace(/\p{M}+/gu, "");
    if (candidate && [...candidate].every((part) => sceneLabelFontCovers(part.codePointAt(0)!))) return candidate;
  }
  return MISSING_GLYPH;
}
