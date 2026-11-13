import { classifyResultProvenance, isStructuralResultSummary } from "@openfea/schema";
import type { DisplayModel, ResultField, ResultProvenance, ResultSummary, Study } from "@openfea/schema";
import { isComplexGeometry } from "./workers/openfeaCoreSolve";

export const PREVIEW_GEOMETRY_WARNING = "OpenFEA Core Preview mesh does not match this geometry; deformed shape disabled.";
export const INVALID_REACTION_WARNING = "Reaction force unavailable or invalid for this result.";

export function isPreviewResultProvenance(provenance: ResultProvenance | undefined): boolean {
  return provenance?.solver === "opencae-core-preview-sdof" ||
    provenance?.solver === "opencae-core-preview-tet4" ||
    provenance?.meshSource === "structured_block_proxy" ||
    provenance?.meshSource === "display_bounds_proxy" ||
    provenance?.resultSource === "computed_preview";
}

export interface ResultTierChip {
  label: string;
  /** computed: production FEA; approximation: preview/estimate; reference: closed-form benchmark. */
  tone: "computed" | "approximation" | "reference" | "historical" | "unknown";
  description: string;
}

/**
 * The visible tier chip shown beside a result's verdict and headline. It is a pure
 * presentation of `classifyResultProvenance`: it never promotes or merges tiers, so
 * a preview or estimate can never read as computed FEA (and vice versa).
 */
export function resultTierChip(provenance: ResultProvenance | undefined): ResultTierChip {
  const tier = classifyResultProvenance(provenance);
  if (tier === "production_fea") return { label: "Computed FEA", tone: "computed", description: "Solved by the finite-element solver on the generated volume mesh." };
  if (tier === "core_preview") return { label: "Preview (coarse proxy)", tone: "approximation", description: "Solved on a coarse block proxy of the geometry, not on a volume mesh of the real part. Use it for orientation only." };
  if (tier === "local_estimate") return { label: "Estimate — not FEA", tone: "approximation", description: "Approximate estimate, not a finite-element solve. Do not use it for design decisions." };
  if (tier === "analytical_benchmark") return { label: "Analytical benchmark", tone: "reference", description: "Closed-form reference solution used to check the solver, not a solve of this part." };
  if (tier === "imported_legacy") return { label: "Legacy result", tone: "historical", description: "Historical result from a retired backend. Re-run to get a current result." };
  return { label: "Unverified source", tone: "unknown", description: "The result does not state how it was produced." };
}

export function hasPreviewResultProvenance(summary: ResultSummary | undefined, fields: ResultField[] = []): boolean {
  return isPreviewResultProvenance(summary?.provenance) || fields.some((field) => isPreviewResultProvenance(field.provenance));
}

export function shouldBlockPreviewResultsForDisplayModel(displayModel: DisplayModel, summary: ResultSummary | undefined, fields: ResultField[] = [], study?: Study): boolean {
  return isComplexGeometry(displayModel, study) && hasPreviewResultProvenance(summary, fields);
}

export function hasNonzeroAppliedLoads(study: Study): boolean {
  return study.loads.some((load) => {
    const value = Number(load.parameters.value);
    return Number.isFinite(value) && value > 0;
  });
}

export function hasInvalidReactionForce(summary: ResultSummary | undefined, study?: Study): boolean {
  if (!summary || !isStructuralResultSummary(summary)) return false;
  const reaction = Number(summary?.reactionForce);
  return Boolean(study && hasNonzeroAppliedLoads(study) && (!Number.isFinite(reaction) || reaction <= 0));
}

export function hasUnavailableReactionDiagnostic(summary: ResultSummary | undefined): boolean {
  return Boolean(summary?.diagnostics?.some((diagnostic) => /reaction force unavailable/i.test(diagnostic.message)));
}

export function canShowReverseLoadCapacity(summary: ResultSummary, displayModel: DisplayModel, fields: ResultField[], study: Study): boolean {
  if (!isStructuralResultSummary(summary)) return false;
  if (summary.provenance?.kind !== "opencae_core_fea" || summary.provenance.resultSource !== "computed") return false;
  if (shouldBlockPreviewResultsForDisplayModel(displayModel, summary, fields, study)) return false;
  if (hasInvalidReactionForce(summary, study)) return false;
  if (hasUnavailableReactionDiagnostic(summary)) return false;
  return true;
}
