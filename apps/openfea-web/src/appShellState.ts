export function shouldShowStartScreen({
  homeRequested,
  hasProject,
  hasDisplayModel,
  hasStudy
}: {
  homeRequested: boolean;
  hasProject: boolean;
  hasDisplayModel: boolean;
  hasStudy: boolean;
}) {
  return homeRequested || !hasProject || !hasDisplayModel;
}

export function shouldAutoAdvanceAfterMeshGeneration() {
  return false;
}

export function shouldAutoAdvanceAfterMaterialAssignment() {
  return false;
}

/**
 * Every workflow step can be opened at any time. Run used to stay locked until a
 * mesh existed, which hid the one place that explains what still blocks the run
 * (the Readiness checklist). The Run step now opens early with the Run button
 * disabled, and each unmet checklist row links to the step that resolves it.
 * The signature is kept so every caller (stepper, Back/Next, N/B shortcuts) keeps
 * asking one place, should a step ever need gating again.
 */
export function canNavigateToStep(_step: string, _context: { meshStatus: string }) {
  return true;
}

/**
 * Undo and redo change the project the last results were computed from, exactly
 * like an edit does, so they mark those results outdated rather than destroying
 * them. They used to call the full run invalidation and dropped every result
 * field on Ctrl+Z.
 *
 * Returns the outdated reason to record, and whether the "results are now
 * outdated" notice should be pushed (only on the first change after a run), or
 * null when there are no results to mark.
 */
export function resultsOutdatedAfterHistoryStep(
  action: "undo" | "redo",
  { hasResults, resultsOutdatedBy }: { hasResults: boolean; resultsOutdatedBy: string | null }
): { outdatedBy: string; announce: boolean } | null {
  if (!hasResults) return null;
  return { outdatedBy: action === "undo" ? "Undo applied." : "Redo applied.", announce: !resultsOutdatedBy };
}

const WORKFLOW_STEP_ORDER = ["model", "material", "supports", "loads", "mesh", "run", "results"] as const;

export type WorkflowShortcutStep = (typeof WORKFLOW_STEP_ORDER)[number];

export function workflowStepForShortcut(
  shortcut: string,
  activeStep: string,
  { meshStatus, studyType }: { meshStatus: string; studyType?: string }
): WorkflowShortcutStep | null {
  // Modal studies hide the Loads step; N/B must skip it too, or the shortcut
  // opens a panel that reads "Step 0 of 6" (2026-09 review D17).
  const order = studyType === "modal_analysis" ? WORKFLOW_STEP_ORDER.filter((step) => step !== "loads") : WORKFLOW_STEP_ORDER;
  const activeIndex = order.findIndex((step) => step === activeStep);
  if (activeIndex < 0) return null;
  const key = shortcut.toLowerCase();
  const targetIndex = key === "n" ? activeIndex + 1 : key === "b" ? activeIndex - 1 : -1;
  const target = order[targetIndex];
  if (!target || !canNavigateToStep(target, { meshStatus })) return null;
  return target;
}

export function isEditableShortcutTarget(target: Pick<HTMLElement, "tagName" | "isContentEditable"> | null) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function printLayerOrientationForViewer<T extends string>(assigned: T | null, preview: T | null | undefined): T | null {
  return preview === undefined ? assigned : preview;
}
