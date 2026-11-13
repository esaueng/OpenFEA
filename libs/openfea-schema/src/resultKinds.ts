import type { ModalResultSummary, ResultSummary, StructuralResultSummary, ThermalResultSummary } from "./index";

export function isModalResultSummary(summary: ResultSummary): summary is ModalResultSummary {
  return "analysisType" in summary && summary.analysisType === "modal_analysis";
}

export function isThermalResultSummary(summary: ResultSummary): summary is ThermalResultSummary {
  return "analysisType" in summary && summary.analysisType === "steady_state_thermal";
}

export function isStructuralResultSummary(summary: ResultSummary): summary is StructuralResultSummary {
  return !isModalResultSummary(summary) && !isThermalResultSummary(summary);
}
