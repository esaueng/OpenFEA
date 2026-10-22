import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReportData } from "./reportData";
import { boundaryFrameHeight, renderReportPdf } from "./reportPdf";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4XmOQz7/wHwAEbQJe8AlDgQAAAABJRU5ErkJggg==";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderReportPdf", () => {
  test("renders a multi-page PDF and tolerates font/logo fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const blob = await renderReportPdf(fixtureReport());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);

    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    expect([...text.matchAll(/\/Type \/Page\b/g)].length).toBeGreaterThanOrEqual(2);
    expect(blob.type).toBe("application/pdf");
  });

  // Visual QA: `REPORT_PDF_QA_OUTPUT=<path>.pdf npx vitest run src/report/reportPdf.test.ts`
  // writes the fixture with the real IBM Plex fonts and a representative 1600x900 capture,
  // plus a `-nonproduction.pdf` variant (preview callout, failing verdict, wrapped KPIs).
  test.skipIf(!process.env.REPORT_PDF_QA_OUTPUT)("writes QA PDFs with real fonts and a representative capture", async () => {
    const qaOutput = process.env.REPORT_PDF_QA_OUTPUT!;
    vi.resetModules(); // the font promise is module-cached; the offline tests above cached null
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const name = String(url).split("?")[0]!.split("/").pop()!;
      const path = name === "openfea-logo.png" ? resolve(__dirname, "../../public", name) : resolve(__dirname, "fonts", name);
      const bytes = readFileSync(path);
      return new Response(bytes);
    }));
    const { renderReportPdf: render } = await import("./reportPdf");
    const capture = syntheticStressCapture(1600, 900);
    const data = fixtureReport();
    data.figures.stress.png = capture;
    data.figures.displacement.png = capture;
    data.boundaryFigure.png = capture;
    mkdirSync(dirname(qaOutput), { recursive: true });
    writeFileSync(qaOutput, new Uint8Array(await (await render(data)).arrayBuffer()));

    const variant = fixtureReport();
    variant.figures.stress.png = capture;
    variant.provenanceTier = "core_preview";
    variant.provenanceLabel = "OpenFEA Core preview (coarse mesh, not production FEA)";
    variant.failureAssessment = { status: "fail", title: "Exceeds allowable limit", message: "The reported factor of safety is below 1.0, so the part is expected to yield under this load case. Reduce the load or stiffen the section and re-run." };
    variant.keyResults = [...variant.keyResults, { label: "Peak displacement", value: "0.0072 in" }];
    writeFileSync(qaOutput.replace(/\.pdf$/, "") + "-nonproduction.pdf", new Uint8Array(await (await render(variant)).arrayBuffer()));
  });

  test("renders the modal mass participation table when present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const data = fixtureReport();
    const without = new Uint8Array(await (await renderReportPdf(data)).arrayBuffer());
    data.massParticipation = {
      headers: ["Mode", "Frequency", "X mass", "X %", "Y mass", "Y %", "Z mass", "Z %"],
      rows: [
        ["1", "59.66 Hz", "0 kg", "0.0%", "0 kg", "0.0%", "6.588 kg", "61.0%"],
        ["Cumulative", "", "0 kg", "0.0%", "0 kg", "0.0%", "6.588 kg", "61.0%"]
      ],
      footnote: "Effective mass per global direction as a percent of the total model mass 10.8 kg."
    };
    const withTable = new Uint8Array(await (await renderReportPdf(data)).arrayBuffer());
    expect(new TextDecoder().decode(withTable.slice(0, 4))).toBe("%PDF");
    expect(withTable.byteLength).toBeGreaterThan(without.byteLength);
  });

  test("renders an empty-data report with explicit unavailable values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const empty = fixtureReport();
    empty.geometry = [];
    empty.geometryFiles.rows = [];
    empty.materials.rows = [];
    empty.manufacturing.rows = [];
    empty.supports.rows = [];
    empty.loads.rows = [];
    empty.mesh = [];
    empty.solver = [];
    empty.results = [];
    empty.loadCapacity = [];
    empty.diagnostics = [];
    empty.figures.stress.png = undefined;
    empty.figures.displacement.png = undefined;
    empty.boundaryFigure.png = undefined;
    empty.boundaryFigure.markerKey = [];

    await expect(renderReportPdf(empty)).resolves.toBeInstanceOf(Blob);
  });

  test("renders the cover with non-production callout, wrapped KPIs and a failing verdict", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
    const data = fixtureReport();
    data.provenanceTier = "core_preview";
    data.provenanceLabel = "Preview estimate";
    data.failureAssessment = { status: "fail", title: "Exceeds allowable limit", message: "The reported factor of safety is below 1.0, so the part is expected to yield under this load case. Reduce the load or stiffen the section and re-run." };
    data.keyResults = [...data.keyResults, { label: "Extra", value: "Unit missing" }];
    const text = new TextDecoder("latin1").decode(new Uint8Array(await (await renderReportPdf(data)).arrayBuffer()));
    expect(text).toContain("%PDF");
  });
});

describe("boundaryFrameHeight", () => {
  const CONTENT_WIDTH = 174; // A4 at REPORT_LAYOUT.margin 18
  const MAX_HEIGHT = 108;

  test("sizes the frame so a content-cropped capture spans the content width", () => {
    // Aspect of a real cropped boundary capture (1797x1038): tall enough to be
    // capped, so the image fills the full width of the page.
    expect(boundaryFrameHeight(pngFixture(1797, 1038), CONTENT_WIDTH, MAX_HEIGHT)).toBe(96);
    // A squarer capture would want more height than the page can spare.
    expect(boundaryFrameHeight(pngFixture(1000, 900), CONTENT_WIDTH, MAX_HEIGHT)).toBe(96);
    // A wide, flat capture gets a short frame instead of empty page.
    expect(boundaryFrameHeight(pngFixture(3000, 500), CONTENT_WIDTH, MAX_HEIGHT)).toBe(45);
    // A moderately wide capture is driven by its own aspect, not the cap.
    expect(boundaryFrameHeight(pngFixture(2000, 800), CONTENT_WIDTH, MAX_HEIGHT)).toBe(68);
  });

  test("falls back to a fixed ratio when no capture is available", () => {
    expect(boundaryFrameHeight(undefined, CONTENT_WIDTH, MAX_HEIGHT)).toBe(96);
  });
});

// A cantilever-shaped band coloured along its length on a white ground, standing in for a
// real viewport capture so the QA PDF shows how the cover figure fills its frame.
function syntheticStressCapture(width: number, height: number): string {
  const ramp = [[11, 87, 208], [14, 165, 233], [34, 197, 94], [250, 204, 21], [249, 115, 22], [239, 68, 68]];
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const t = x / width;
      const top = height * (0.38 + 0.08 * t * t);
      if (x < width * 0.08 || x > width * 0.92 || y < top || y > top + height * 0.2) continue;
      const color = ramp[Math.min(ramp.length - 1, Math.floor((1 - (x - width * 0.08) / (width * 0.84)) * ramp.length))]!;
      raw.set(color, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal PNG header (signature + IHDR width/height) — enough for pngDimensions.
function pngFixture(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return `data:image/png;base64,${header.toString("base64")}`;
}

function fixtureReport(): ReportData {
  const rows = [
    { label: "Result source", value: "OpenFEA Core Local (in-browser)" },
    { label: "Max stress", value: "142 MPa" },
    { label: "Max displacement", value: "0.184 mm" }
  ];
  return {
    pageFormat: "a4",
    filename: "OpenFEA-Report_fixture_2026-07-10.pdf",
    generatedAtIso: "2026-07-10T12:00:00.000Z",
    reportDate: "2026-07-10",
    title: "Dynamic Structural Simulation Report",
    projectName: "Cantilever Fixture",
    studyName: "Dynamic Structural",
    coverContext: "Cantilever · Aluminum 6061 · 500 N force",
    unitSystemLabel: "SI (m, Pa)",
    provenanceTier: "production_fea",
    provenanceLabel: "OpenFEA Core Local (in-browser)",
    coverMeta: [
      { label: "Solver", value: "OpenFEA Core Local (in-browser)" },
      { label: "Version", value: "0.2.0" },
      { label: "Method", value: "mdof_dynamic" },
      { label: "Mesh", value: "Tet10 · 26,944 elements" }
    ],
    keyResults: [
      { label: "Max von Mises stress", value: "142 MPa" },
      { label: "Max displacement", value: "0.184 mm" },
      { label: "Safety factor", value: "1.8" },
      { label: "Reaction force", value: "500 N" }
    ],
    failureAssessment: { status: "pass", title: "Within allowable limit", message: "The reported factor of safety is above 1.0." },
    geometry: [{ label: "Source", value: "Sample model: Cantilever (procedural)" }],
    geometryFiles: { headers: ["File", "Format", "Size"], rows: [["cantilever.step", "STEP", "12.0 KB"]] },
    materials: { headers: ["Material / target", "Young's modulus", "Poisson ratio", "Density", "Yield strength"], rows: [["Aluminum 6061 / Body", "68,900 MPa", "0.33", "2,700 kg/m^3", "276 MPa"]] },
    manufacturing: { headers: ["Material / target", "Process", "Process settings"], rows: [["Aluminum 6061 / Body", "CNC machining", "Solid stock · Isotropic"]] },
    supports: { headers: ["Support", "Target"], rows: [["Fixed support", "Fixed end"]] },
    loads: { headers: ["Load", "Magnitude", "Direction", "Target"], rows: [["Force", "500 N", "[0, 0, -1]", "Free end"]] },
    boundaryFigure: {
      title: "Boundary conditions on model",
      png: ONE_PIXEL_PNG,
      unavailableLabel: "Not captured for this run — open the Results view once, then regenerate the report.",
      caption: "Support and load markers as placed in the study, shown on the undeformed model.",
      markerKey: [
        "FS n — fixed support on the constrained face (1 in this study)",
        "L n — applied load at its application point; the arrow shows the load direction (1 in this study)"
      ]
    },
    mesh: [{ label: "Nodes", value: "42,381" }, { label: "Elements", value: "26,944" }, { label: "Element type", value: "Tet10" }],
    meshConvergence: null,
    meshQuality: [
      { label: "Elements checked", value: "26,944 Tet10 elements" },
      { label: "Scaled Jacobian — worst / worst 5% / median", value: "0.214 / 0.512 / 0.803 (0 < 0.2)" },
      { label: "Tet10 det J ≤ 0 at a Gauss point", value: "0" },
      { label: "Elements past any quality threshold", value: "12 of 26,944 (display only; thresholds are OpenFEA warning levels and do not block solving)" }
    ],
    solver: rows,
    figures: {
      stress: { title: "Von Mises stress", png: ONE_PIXEL_PNG, unavailableLabel: "Not available (--)", legendMin: "0 MPa", legendMax: "142 MPa", caption: "Von Mises stress (MPa). Automatically selected peak von Mises stress frame (frame 17 of 21, 0.0800 s). Deformed shape, ×2,150 exaggeration at ×1.8 emphasis (display only)." },
      displacement: { title: "Displacement magnitude", png: ONE_PIXEL_PNG, unavailableLabel: "Not available (--)", legendMin: "0 mm", legendMax: "0.184 mm", caption: "Displacement magnitude (mm). Automatically selected peak displacement magnitude frame (frame 21 of 21, 0.1000 s). Deformed shape, ×2,150 exaggeration at ×1.8 emphasis (display only)." }
    },
    results: rows,
    loadCapacity: [
      { label: "Current applied load", value: "500 N" },
      { label: "Max theoretical load (at FoS 1.0)", value: "900 N" },
      { label: "Target factor of safety", value: "1.5" },
      { label: "Max load at target FoS", value: "600 N (1.2x current)" }
    ],
    transientResults: [],
    diagnostics: ["Fixture diagnostic."],
    includeSmoothingDisclaimer: true,
    footerDisclaimer: "Development-grade analysis. Not a substitute for professional engineering review."
  };
}
