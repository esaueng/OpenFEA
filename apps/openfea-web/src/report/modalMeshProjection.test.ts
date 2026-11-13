import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { elevateTet4MeshToTet10, extractBoundarySurfaceFacets, type OpenFEAModelJson } from "@openfea/core";
import { bracketDemoProject, bracketDisplayModel } from "@openfea/samples";
import { isModalResultSummary, type Project, type ResultField, type ResultSummary, type Study } from "@openfea/schema";
import { parseResultBundle } from "../appPersistence";
import { withFieldRunIds, type ResultsResponse } from "../lib/api";
import { openLocalProjectPayload } from "../localProjectFactory";
import { trySolveOpenFeaCoreStudy } from "../workers/openfeaCoreSolve";
import { buildReportData } from "./reportData";

const PROJECTION_LINE = "Mesh projection for solve: Tet10 → Tet4 (local-modal-performance). Results are computed on the projected mesh.";

/**
 * A 40 mm aluminum cube, 13 Kuhn-split cells per side, elevated to Tet10: just
 * above the 50,000-DOF threshold where the local modal solve projects to Tet4
 * (~8k solve DOFs, so the real solve stays quick). The x = 0 face carries the
 * bracket demo's fixed-support selection.
 */
function projectedModalCubeModel(): OpenFEAModelJson {
  const cells = 13;
  const side = 0.04;
  const nodeIndex = (i: number, j: number, k: number) => (i * (cells + 1) + j) * (cells + 1) + k;
  const coordinates: number[] = [];
  for (let i = 0; i <= cells; i += 1) {
    for (let j = 0; j <= cells; j += 1) {
      for (let k = 0; k <= cells; k += 1) coordinates.push((side * i) / cells, (side * j) / cells, (side * k) / cells);
    }
  }
  const tet4: number[][] = [];
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      for (let k = 0; k < cells; k += 1) {
        const c = [
          nodeIndex(i, j, k), nodeIndex(i + 1, j, k), nodeIndex(i + 1, j + 1, k), nodeIndex(i, j + 1, k),
          nodeIndex(i, j, k + 1), nodeIndex(i + 1, j, k + 1), nodeIndex(i + 1, j + 1, k + 1), nodeIndex(i, j + 1, k + 1)
        ] as const;
        tet4.push([c[0], c[1], c[2], c[6]], [c[0], c[2], c[3], c[6]], [c[0], c[3], c[7], c[6]], [c[0], c[7], c[4], c[6]], [c[0], c[4], c[5], c[6]], [c[0], c[5], c[1], c[6]]);
      }
    }
  }
  const elevated = elevateTet4MeshToTet10({ coordinates, elements: tet4 });
  const base: OpenFEAModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.4.0",
    nodes: { coordinates: elevated.coordinates },
    materials: [{ name: "mat-aluminum-6061", type: "isotropicLinearElastic", youngModulus: 68.9e9, poissonRatio: 0.33, yieldStrength: 276e6, density: 2700 }],
    elementBlocks: [{ name: "actual-volume", type: "Tet10", material: "mat-aluminum-6061", connectivity: elevated.elements.flat() }],
    nodeSets: [],
    elementSets: [],
    boundaryConditions: [],
    loads: [],
    steps: [],
    coordinateSystem: { solverUnits: "m-N-s-Pa", renderCoordinateSpace: "solver" },
    meshProvenance: { kind: "opencae_core_fea", solver: "opencae-core-local", resultSource: "computed", meshSource: "actual_volume_mesh" }
  };
  const surfaceFacets = extractBoundarySurfaceFacets(base).map((facet) => (
    facet.nodes.every((node) => elevated.coordinates[node * 3] === 0)
      ? { ...facet, sourceSelectionRef: "selection-fixed-face", sourceFaceId: "face-base-left" }
      : facet
  ));
  return { ...base, surfaceFacets };
}

function modalStudyWithStoredMesh(model: OpenFEAModelJson): Study {
  const base = bracketDemoProject.studies[0]!;
  return {
    ...base,
    id: "study-modal-projected",
    name: "Modal Analysis",
    type: "modal_analysis",
    loads: [],
    loadCases: undefined,
    loadCombinations: undefined,
    solverSettings: { backend: "opencae_core_local", fidelity: "standard", modeCount: 1 },
    meshSettings: {
      preset: "fine",
      status: "complete",
      meshRef: "project-bracket-demo/mesh/core-volume-model.json",
      summary: {
        nodes: model.nodes.coordinates.length / 3,
        elements: model.elementBlocks[0]!.connectivity.length / 10,
        warnings: [],
        source: "actual_volume_mesh",
        artifacts: { meshConnectivity: { connectedComponents: 1 }, actualCoreModel: { model } }
      }
    } as Study["meshSettings"]
  } as Study;
}

function reportDiagnostics(study: Study, resultSummary: ResultSummary, resultFields: ResultField[], unitSystem: "SI" | "US" = "SI"): string[] {
  const project: Project = { ...bracketDemoProject, studies: [study] };
  return buildReportData({
    project,
    study,
    displayModel: bracketDisplayModel,
    resultSummary,
    resultFields,
    solverMeshSummary: null,
    runTiming: null,
    unitSystem,
    captures: {},
    generatedAt: new Date("2026-11-13T12:00:00.000Z"),
    exaggeration: 1,
    showDeformed: false
  }).diagnostics;
}

describe("modal Tet10 → Tet4 mesh projection in saved results and reports", () => {
  // Regression: the projection lived only in the run-level Core diagnostics, which are
  // not saved with the results, so the report's projection line never printed. The
  // summary diagnostic now carries the line and the structured payload, and both persist.
  test("a projected local modal solve persists the projection and its report prints the line", { timeout: 60_000 }, () => {
    const model = projectedModalCubeModel();
    expect(model.nodes.coordinates.length).toBeGreaterThan(50_000);
    const study = modalStudyWithStoredMesh(model);

    const outcome = trySolveOpenFeaCoreStudy({ study, runId: "run-modal-projected", displayModel: bracketDisplayModel });
    expect(outcome.ok, outcome.ok ? undefined : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.solverBackend).toBe("opencae-core-modal-tet");
    const summary = outcome.result.summary;
    if (!isModalResultSummary(summary)) throw new Error("Expected a modal summary.");
    expect(summary.massParticipation?.computedOnProjectedModel).toBe(true);
    // Provenance tier is unchanged: still computed Core FEA on the stored volume mesh.
    expect(summary.provenance).toMatchObject({ kind: "opencae_core_fea", resultSource: "computed", meshSource: "actual_volume_mesh" });
    const projectionDiagnostic = summary.diagnostics?.find((diagnostic) => diagnostic.meshProjection);
    expect(projectionDiagnostic).toMatchObject({
      id: "modal-mesh-projection",
      severity: "warning",
      source: "solver",
      message: PROJECTION_LINE,
      meshProjection: {
        sourceElementOrder: "Tet10",
        solveElementOrder: "Tet4",
        sourceDofs: model.nodes.coordinates.length,
        reason: "local-modal-performance"
      }
    });
    expect(projectionDiagnostic?.meshProjection?.solveDofs).toBeLessThan(projectionDiagnostic!.meshProjection!.sourceDofs);

    // Save and reopen the results the way the workspace autosave does, after the run stamps its fields.
    const stamped = withFieldRunIds("run-modal-projected", outcome.result as ResultsResponse);
    const saved = JSON.parse(JSON.stringify({ completedRunId: "run-modal-projected", summary: stamped.summary, fields: stamped.fields }));
    const reopened = parseResultBundle(saved, { provenance: "keep" });
    expect(reopened).toBeDefined();
    expect(reopened!.summary.diagnostics?.find((diagnostic) => diagnostic.id === "modal-mesh-projection")?.meshProjection)
      .toEqual(projectionDiagnostic!.meshProjection);

    for (const unitSystem of ["SI", "US"] as const) {
      const diagnostics = reportDiagnostics(study, reopened!.summary, reopened!.fields, unitSystem);
      // Printed once, though both the message and the payload produce it.
      expect(diagnostics.filter((line) => line === PROJECTION_LINE)).toHaveLength(1);
      expect(diagnostics).toContain(summary.warning);
    }
  });

  test("a project saved before the projection was persisted still opens and reports", () => {
    // Version-2 file written by the previous release: a projected modal result whose
    // summary has no projection diagnostic (only massParticipation.computedOnProjectedModel).
    const file = JSON.parse(readFileSync(resolve(__dirname, "../testdata/modal-projection/pre-projection-diagnostic-modal-project.openfea.json"), "utf8")) as Record<string, unknown>;
    const opened = openLocalProjectPayload(file);
    expect(opened.results).toBeDefined();
    const summary = opened.results!.summary;
    if (!isModalResultSummary(summary)) throw new Error("Expected a modal summary.");
    expect(summary.convergedModeCount).toBe(2);
    expect(summary.massParticipation?.computedOnProjectedModel).toBe(true);
    expect(summary.diagnostics?.some((diagnostic) => diagnostic.meshProjection)).toBe(false);
    const study = opened.project.studies[0]!;
    expect(study.type).toBe("modal_analysis");

    const diagnostics = reportDiagnostics(study, summary, opened.results!.fields);
    expect(diagnostics).toContain(summary.warning);
    // Nothing invents a projection payload the old file never stored.
    expect(diagnostics).not.toContain(PROJECTION_LINE);
  });

  test("results saved with the projection line but no structured payload still report it", () => {
    // Shape written after the summary started carrying solver warnings but before the
    // structured `meshProjection` payload was persisted.
    const file = JSON.parse(readFileSync(resolve(__dirname, "../testdata/modal-projection/pre-projection-diagnostic-modal-project.openfea.json"), "utf8")) as {
      project: Project;
      results: { summary: { diagnostics: unknown[] } };
    };
    file.results.summary.diagnostics = [{ id: "modal-mesh-projection", severity: "warning", source: "solver", message: PROJECTION_LINE, suggestedActions: [] }];
    const reopened = parseResultBundle(file.results, { provenance: "keep" });
    expect(reopened).toBeDefined();
    expect(reopened!.summary.diagnostics?.[0]).not.toHaveProperty("meshProjection");
    const diagnostics = reportDiagnostics(openLocalProjectPayload(file).project.studies[0]!, reopened!.summary, reopened!.fields);
    expect(diagnostics.filter((line) => line === PROJECTION_LINE)).toHaveLength(1);
  });

  test("an unreadable stored projection payload is dropped instead of rejecting the results", () => {
    const file = JSON.parse(readFileSync(resolve(__dirname, "../testdata/modal-projection/pre-projection-diagnostic-modal-project.openfea.json"), "utf8")) as {
      results: { summary: { diagnostics: unknown[] } };
    };
    file.results.summary.diagnostics = [{
      id: "modal-mesh-projection", severity: "warning", source: "solver", message: "Projected.", suggestedActions: [],
      meshProjection: { sourceElementOrder: "Hex27", solveElementOrder: "Tet4", sourceDofs: -1, solveDofs: 1, reason: "x" }
    }];
    const reopened = parseResultBundle((file as unknown as { results: unknown }).results, { provenance: "keep" });
    expect(reopened).toBeDefined();
    expect(reopened!.summary.diagnostics?.[0]?.message).toBe("Projected.");
    expect(reopened!.summary.diagnostics?.[0]?.meshProjection).toBeUndefined();
  });
});
