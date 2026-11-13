import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { sceneLabelFontCovers, sceneLabelText } from "./sceneLabelText";

const FONT_PATH = resolve(__dirname, "assets/fonts/ibm-plex-sans-latin-500-normal.woff");

describe("scene label font coverage", () => {
  test("matches the code points the bundled WOFF actually maps", () => {
    const fontCodePoints = woffCodePoints(readFileSync(FONT_PATH));
    expect(fontCodePoints.size).toBeGreaterThan(200);
    const mismatched: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += codePoint < 0x10000 ? 1 : 0x1000) {
      if (sceneLabelFontCovers(codePoint) !== fontCodePoints.has(codePoint)) mismatched.push(codePoint.toString(16));
    }
    // On failure, regenerate the class from the font's ranges:
    expect(mismatched, JSON.stringify(codePointRanges(fontCodePoints))).toEqual([]);
  });
});

describe("sceneLabelText", () => {
  // troika (via drei Text) sends any character the font lacks to
  // unicode-font-resolver, which fetches from cdn.jsdelivr.net. Everything the
  // sanitizer returns must be covered, except whitespace after the first
  // character, which troika carries forward without resolving.
  function expectNoFallback(text: string) {
    [...text].forEach((char, index) => {
      if (index > 0 && /\s/.test(char)) return;
      expect(sceneLabelFontCovers(char.codePointAt(0)!), `U+${char.codePointAt(0)!.toString(16)} in ${JSON.stringify(text)}`).toBe(true);
    });
  }

  test("leaves text the face covers untouched", () => {
    for (const text of ["Peak 1.827 MPa", "0.001433 mm", "Open section", "12 °C · 3 W/m²", "Fixture – left hole", "F = 250 N"]) {
      const safe = sceneLabelText(text);
      expectNoFallback(safe);
      expect(safe).toBe(text);
    }
  });

  test("replaces glyphs outside the face with readable stand-ins", () => {
    expect(sceneLabelText("kg/m⁴")).toBe("kg/m^4");
    expect(sceneLabelText("1.2e⁻⁴ m")).toBe("1.2e^-4 m");
    expect(sceneLabelText("m²")).toBe("m²");
    expect(sceneLabelText("σ₁")).toBe("?1");
    expect(sceneLabelText("10 μm")).toBe("10 µm");
    expect(sceneLabelText("a → b ≈ c ≤ d")).toBe("a -> b ~ c <= d");
    expect(sceneLabelText("Dvořák")).toBe("Dvorák");
    expect(sceneLabelText("支架")).toBe("??");
    expect(sceneLabelText("😀 load")).toBe("? load");
  });

  test("drops leading whitespace troika would resolve but keeps inner line breaks", () => {
    expect(sceneLabelText("\n\nLoad\r\n10 N")).toBe("Load\n10 N");
    expect(sceneLabelText("\tLoad")).toBe(" Load");
  });

  test("never emits a character that would reach the CDN font resolver", () => {
    const samples = ["σ₁ ⁻⁰¹²³⁴⁵⁶⁷⁸⁹ ₀₉", "́e", "Ωμ∑∫√∞", "ﬁ ① ㎜", "Привет", " x­", String.fromCodePoint(0x1f600, 0x10ffff)];
    for (const text of samples) expectNoFallback(sceneLabelText(text));
  });

  test("no scene component imports drei's Text directly", () => {
    const offenders: string[] = [];
    const root = resolve(__dirname);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !path.endsWith("SceneLabelText.tsx")) {
          const source = readFileSync(path, "utf8");
          if (/import\s*\{[^}]*\bText\b[^}]*\}\s*from\s*"@react-three\/drei"/.test(source)) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

/** Code points a WOFF 1.0 font maps to a non-zero glyph (cmap formats 4 and 12). */
function woffCodePoints(woff: Uint8Array): Set<number> {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (view.getUint32(0) !== 0x774f4646) throw new Error("not a WOFF 1.0 file");
  for (let index = 0; index < view.getUint16(12); index += 1) {
    const entry = 44 + index * 20;
    if (String.fromCharCode(...woff.subarray(entry, entry + 4)) !== "cmap") continue;
    const offset = view.getUint32(entry + 4);
    const compLength = view.getUint32(entry + 8);
    const raw = woff.subarray(offset, offset + compLength);
    return cmapCodePoints(compLength === view.getUint32(entry + 12) ? raw : new Uint8Array(inflateSync(raw)));
  }
  throw new Error("WOFF has no cmap table");
}

function cmapCodePoints(cmap: Uint8Array): Set<number> {
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const out = new Set<number>();
  for (let index = 0; index < view.getUint16(2); index += 1) {
    const platform = view.getUint16(4 + index * 8);
    const encoding = view.getUint16(6 + index * 8);
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const offset = view.getUint32(8 + index * 8);
    const format = view.getUint16(offset);
    if (format === 4) {
      const segCount = view.getUint16(offset + 6) / 2;
      const endCodes = offset + 14;
      const startCodes = endCodes + segCount * 2 + 2;
      const idDeltas = startCodes + segCount * 2;
      const idRangeOffsets = idDeltas + segCount * 2;
      for (let segment = 0; segment < segCount; segment += 1) {
        const end = view.getUint16(endCodes + segment * 2);
        const start = view.getUint16(startCodes + segment * 2);
        const delta = view.getInt16(idDeltas + segment * 2);
        const rangeOffsetAt = idRangeOffsets + segment * 2;
        const rangeOffset = view.getUint16(rangeOffsetAt);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          const rawGlyph = rangeOffset === 0 ? code : view.getUint16(rangeOffsetAt + rangeOffset + (code - start) * 2);
          if (rangeOffset !== 0 && rawGlyph === 0) continue;
          if (((rawGlyph + delta) & 0xffff) !== 0) out.add(code);
        }
      }
    } else if (format === 12) {
      for (let group = 0; group < view.getUint32(offset + 12); group += 1) {
        const at = offset + 16 + group * 12;
        const startGlyph = view.getUint32(at + 8);
        for (let code = view.getUint32(at); code <= view.getUint32(at + 4); code += 1) {
          if (startGlyph + (code - view.getUint32(at)) !== 0) out.add(code);
        }
      }
    }
  }
  return out;
}

function codePointRanges(codePoints: Iterable<number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const code of [...codePoints].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && code === last[1] + 1) last[1] = code;
    else ranges.push([code, code]);
  }
  return ranges;
}
