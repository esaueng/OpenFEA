import type { DisplayModel, Study } from "@openfea/schema";

import {
  type EstimateAnalysis,
  type EstimateElementOrder,
  type SolveTimeEstimate,
  LONG_RUN_WARNING_SECONDS,
  boundingBoxAspectRatio,
  elementOrderForStudy,
  estimateAnalysisForStudy,
  formatAspectRatio,
  formatSolveTimeRange,
  isSlenderAspectRatio,
  solveTimeEstimateForStudy
} from "./lib/runTimeEstimate";

/**
 * Non-blocking Run-panel warnings (plan 036 Release A). Unlike readiness rows
 * (runReadiness.ts) these never gate Run: they tell the user what a run will
 * cost or where the element choice limits accuracy, before they wait for it.
 */
export interface RunAdvisory {
  id: "slender-long-run" | "tet4-bending-locking";
  tone: "warning" | "note";
  title: string;
  text: string;
}

/**
 * Solve-ladder finding (docs/validation/solve-ladder.md): on the 50:1 slender
 * cantilever, Tet4 tip deflection was 10.8–11.9 mm against 12.504 mm from
 * Timoshenko beam theory (5–14% low, converging from below), while Tet10 was
 * within 0.21%. The same stiffening raised Tet4 natural frequencies.
 */
export const TET4_BENDING_LOCKING_NOTE =
  "Linear Tet4 elements are too stiff in bending: on a 50:1 benchmark cantilever they gave 5–14% less deflection than beam theory, where Tet10 was within 1%. " +
  "On a slender or thin part, Tet4 displacements are likely low and natural frequencies high; Tet10 is recommended for bending-dominated parts.";

const ANALYSIS_LABEL: Record<EstimateAnalysis, string> = {
  static: "static",
  modal: "modal",
  dynamic: "dynamic",
  thermal: "thermal"
};

/** Whether the Tet4 bending-locking caveat applies: structural static or modal, Tet4, slender or thin by the bounding-box heuristic. */
export function tet4BendingLockingApplies(input: { analysis: EstimateAnalysis; elementOrder: EstimateElementOrder; aspectRatio: number | null }): boolean {
  return (input.analysis === "static" || input.analysis === "modal") && input.elementOrder === "Tet4" && isSlenderAspectRatio(input.aspectRatio);
}

export function slenderLongRunApplies(estimate: SolveTimeEstimate | null): estimate is SolveTimeEstimate {
  return Boolean(estimate && estimate.slender && estimate.centralSeconds > LONG_RUN_WARNING_SECONDS);
}

export function runAdvisoriesForStudy(study: Study, displayModel: Pick<DisplayModel, "dimensions"> | null | undefined, estimate: SolveTimeEstimate | null = solveTimeEstimateForStudy(study, displayModel)): RunAdvisory[] {
  const advisories: RunAdvisory[] = [];
  const aspectRatio = estimate?.aspectRatio ?? boundingBoxAspectRatio(displayModel?.dimensions);
  const analysis = estimate?.analysis ?? estimateAnalysisForStudy(study);

  if (slenderLongRunApplies(estimate)) {
    const shorter = analysis === "modal" ? "try a coarser mesh preset or request fewer modes" : "try a coarser mesh preset";
    advisories.push({
      id: "slender-long-run",
      tone: "warning",
      title: "Long solve expected",
      text: `This part is slender (bounding box about ${formatAspectRatio(estimate.aspectRatio!)}), and the ${ANALYSIS_LABEL[analysis]} solve is projected to take ${formatSolveTimeRange(estimate)}. ` +
        "Slender, bending-dominated parts need far more solver iterations than compact ones (17–23x on the benchmark). " +
        `For a first look, ${shorter}. The estimate is approximate and depends on your browser and device.`
    });
  }

  const elementOrder = estimate?.elementOrder ?? elementOrderForStudy(study);
  if (tet4BendingLockingApplies({ analysis, elementOrder, aspectRatio })) {
    const projected = estimate?.modalProjectedToTet4
      ? " This modal solve runs on a Tet4 projection of the quadratic mesh (above 50k DOF), so the same applies."
      : "";
    advisories.push({ id: "tet4-bending-locking", tone: "note", title: "Tet4 bending stiffness", text: `${TET4_BENDING_LOCKING_NOTE}${projected}` });
  }
  return advisories;
}
