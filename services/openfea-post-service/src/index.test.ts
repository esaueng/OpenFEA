import { describe, expect, test } from "vitest";
import type { ResultSummary } from "@openfea/schema";
import type { ObjectStorageProvider } from "@openfea/storage";
import { buildHtmlReport, buildPdfReport, LocalReportProvider } from "./index";

class MemoryStorage implements ObjectStorageProvider {
  objects = new Map<string, Buffer>();

  async putObject(key: string, data: string | Buffer | Uint8Array): Promise<string> {
    this.objects.set(key, Buffer.from(data));
    return key;
  }

  async getObject(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`missing ${key}`);
    return value;
  }

  async listObjects(prefix = ""): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  getLocalPath(key: string): string {
    return key;
  }
}

describe("LocalReportProvider", () => {
  test("writes reports under the run id", async () => {
    const storage = new MemoryStorage();
    const reports = new LocalReportProvider(storage);

    const first = await reports.generateReport({ projectId: "project-test", runId: "run-a", summary: summary(500) });
    const second = await reports.generateReport({ projectId: "project-test", runId: "run-b", summary: summary(1500) });

    expect(first).toBe("project-test/reports/run-a/report.html");
    expect(second).toBe("project-test/reports/run-b/report.html");
    expect((await storage.getObject(first)).toString("utf8")).toContain("Reaction force</td><td>500 N");
    expect((await storage.getObject(second)).toString("utf8")).toContain("Reaction force</td><td>1,500 N");
    expect((await storage.getObject("project-test/reports/run-a/report.pdf")).subarray(0, 4).toString("utf8")).toBe("%PDF");
    expect((await storage.getObject("project-test/reports/run-b/report.pdf")).subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  test("uses a CAD-like model preview instead of the old block heatmap", () => {
    const html = buildHtmlReport("run-a", summary(500));

    expect(html).toContain("class=\"visual result-model\"");
    expect(html).toContain("Schematic stress contour illustration, not model geometry");
    expect(html).toContain("Schematic illustration - not model geometry");
    expect(html).not.toContain("feGaussianBlur");
  });

  test("prints result provenance and marks local estimates as not analysis", () => {
    const estimateSummary: ResultSummary = {
      ...summary(500),
      provenance: {
        kind: "local_estimate",
        solver: "openfea-local-heuristic-surface",
        solverVersion: "0.1.0",
        meshSource: "mock",
        resultSource: "generated",
        units: "mm-N-s-MPa"
      }
    };

    const html = buildHtmlReport("run-estimate", estimateSummary);
    const pdf = buildPdfReport("run-estimate", estimateSummary).toString("latin1");

    expect(html).toContain("Estimate (not FEA)");
    expect(html).toContain("NOT ANALYSIS");
    expect(html).toContain("openfea-local-heuristic-surface");
    expect(html).toContain("mock");
    expect(html).toContain("generated");
    expect(pdf).toContain("NOT ANALYSIS");
    expect(pdf).toContain("Estimate \\(not FEA\\)");
  });

  test("includes a failure assessment for low safety-factor results", () => {
    const html = buildHtmlReport("run-a", summary(500, 0.82));

    expect(html).toContain("Likely to fail");
    expect(html).toContain("exceeds the assigned material yield limit");
  });

  test("recomputes the assessment instead of trusting imported display text", () => {
    const html = buildHtmlReport("run-a", {
      ...summary(500),
      failureAssessment: {
        status: '"><script>alert(1)</script>' as never,
        title: "Injected <title>",
        message: "Injected <message>"
      }
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('class="assessment "><script>');
    expect(html).toContain('class="assessment pass"');
    expect(html).not.toContain("Injected &lt;title&gt;");
  });

  test("positions the stress marker by safety-factor utilization", () => {
    const comfortable = buildHtmlReport("run-a", summary(500, 2));
    const failing = buildHtmlReport("run-a", summary(500, 0.5));
    const unknown = buildHtmlReport("run-a", summary(500, 0));

    expect(comfortable).toContain("margin-left: 50%");
    expect(failing).toContain("margin-left: 100%");
    expect(unknown).toContain("margin-left: 100%");
  });

  test("labels the PDF header with the dynamic analysis type for transient runs", () => {
    const dynamicSummary: ResultSummary = {
      ...summary(500),
      transient: {
        analysisType: "dynamic_structural",
        integrationMethod: "newmark_average_acceleration",
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        frameCount: 21,
        peakDisplacementTimeSeconds: 0.05,
        peakDisplacement: 0.4
      }
    };

    expect(buildPdfReport("run-a", dynamicSummary).toString("latin1")).toContain("OpenFEA DYNAMIC STRUCTURAL SIMULATION");
    expect(buildPdfReport("run-a", summary(500)).toString("latin1")).toContain("OpenFEA STATIC STRESS SIMULATION");
  });

  test("tabulates modal effective mass with a cumulative row when the summary carries it", () => {
    const modalSummary = {
      analysisType: "modal_analysis",
      requestedModeCount: 2,
      convergedModeCount: 2,
      modes: [
        { modeIndex: 1, frequencyHz: 59.66, eigenvalue: 140520, scaledResidual: 3e-7, fieldId: "mode-1" },
        { modeIndex: 2, frequencyHz: 96.76, eigenvalue: 369610, scaledResidual: 4e-7, fieldId: "mode-2" }
      ],
      massParticipation: {
        massUnits: "t",
        massMatrix: "lumped",
        totalMass: 0.0108,
        unconstrainedMass: [0.01058, 0.01058, 0.01058],
        computedOnProjectedModel: true,
        modes: [
          { modeIndex: 1, participationFactor: [0, 0, 0.0812], effectiveMass: [0, 0, 0.006588], effectiveMassRatio: [0, 0, 0.61], cumulativeEffectiveMassRatio: [0, 0, 0.61] },
          { modeIndex: 2, participationFactor: [0, 0.0811, 0], effectiveMass: [0, 0.006577, 0], effectiveMassRatio: [0, 0.609, 0], cumulativeEffectiveMassRatio: [0, 0.609, 0.61] }
        ]
      },
      diagnostics: []
    } as ResultSummary;

    const html = buildHtmlReport("run-modal", modalSummary);
    expect(html).toContain("Effective mass participation");
    expect(html).toContain("<th>Cumulative</th><th>0.0%</th><th>60.9%</th><th>61.0%</th>");
    expect(html).toContain("total model mass 10.8 kg");
    expect(html).toContain("projected linear Tet4 model");
    expect(buildHtmlReport("run-modal", { ...modalSummary, massParticipation: undefined } as ResultSummary)).not.toContain("Effective mass participation");
  });

  test("escapes modal report counters even when the summary carries markup", () => {
    // The solver emits real numbers, but the report HTML is a trust boundary:
    // a malformed summary must not become markup in a served text/html page.
    const hostile = "<img src=x onerror=alert(1)>";
    const modalSummary = {
      analysisType: "modal_analysis",
      requestedModeCount: hostile,
      convergedModeCount: hostile,
      modes: [{ modeIndex: hostile, frequencyHz: 42, eigenvalue: 1, scaledResidual: 0.001 }]
    } as unknown as ResultSummary;

    const html = buildHtmlReport("run-modal", modalSummary);

    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

function summary(reactionForce: number, safetyFactor = 2): ResultSummary {
  return {
    maxStress: reactionForce / 10,
    maxStressUnits: "MPa",
    maxDisplacement: reactionForce / 1000,
    maxDisplacementUnits: "mm",
    safetyFactor,
    reactionForce,
    reactionForceUnits: "N",
    diagnostics: []
  };
}
