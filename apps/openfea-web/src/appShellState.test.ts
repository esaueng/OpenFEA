import { describe, expect, test } from "vitest";
import {
  canNavigateToStep,
  isEditableShortcutTarget,
  printLayerOrientationForViewer,
  resultsOutdatedAfterHistoryStep,
  workflowStepForShortcut,
  shouldAutoAdvanceAfterMaterialAssignment,
  shouldAutoAdvanceAfterMeshGeneration,
  shouldShowStartScreen
} from "./appShellState";

describe("app shell state", () => {
  test("shows the start screen when home is requested from an open project", () => {
    expect(shouldShowStartScreen({ homeRequested: true, hasProject: true, hasDisplayModel: true, hasStudy: true })).toBe(true);
  });

  test("keeps the workspace open when a project exists before simulation creation", () => {
    expect(shouldShowStartScreen({ homeRequested: false, hasProject: true, hasDisplayModel: true, hasStudy: false })).toBe(false);
  });

  test("does not auto-advance after mesh generation", () => {
    expect(shouldAutoAdvanceAfterMeshGeneration()).toBe(false);
  });

  test("does not auto-advance after material assignment", () => {
    expect(shouldAutoAdvanceAfterMaterialAssignment()).toBe(false);
  });

  test("opens Run before the mesh exists so the readiness checklist can explain the block", () => {
    // Run used to stay locked until the mesh was complete, which hid the one panel
    // that says why the run is blocked. The Run button itself stays disabled.
    expect(canNavigateToStep("run", { meshStatus: "not_started" })).toBe(true);
    expect(canNavigateToStep("run", { meshStatus: "ready" })).toBe(true);
    expect(canNavigateToStep("run", { meshStatus: "complete" })).toBe(true);
    expect(canNavigateToStep("mesh", { meshStatus: "not_started" })).toBe(true);
  });

  test("undo and redo mark results outdated instead of destroying them", () => {
    // Regression: both used to call invalidateCompletedRunState(), dropping every result field.
    expect(resultsOutdatedAfterHistoryStep("undo", { hasResults: true, resultsOutdatedBy: null })).toEqual({ outdatedBy: "Undo applied.", announce: true });
    expect(resultsOutdatedAfterHistoryStep("redo", { hasResults: true, resultsOutdatedBy: null })).toEqual({ outdatedBy: "Redo applied.", announce: true });
    // Already outdated: re-mark with the latest reason, but do not repeat the announcement.
    expect(resultsOutdatedAfterHistoryStep("undo", { hasResults: true, resultsOutdatedBy: "Load updated." })).toEqual({ outdatedBy: "Undo applied.", announce: false });
    // Nothing to mark without results.
    expect(resultsOutdatedAfterHistoryStep("undo", { hasResults: false, resultsOutdatedBy: null })).toBeNull();
  });

  test("maps workflow keyboard shortcuts to adjacent allowed steps", () => {
    expect(workflowStepForShortcut("n", "model", { meshStatus: "not_started" })).toBe("material");
    expect(workflowStepForShortcut("b", "material", { meshStatus: "not_started" })).toBe("model");
    // Modal studies have no Loads step; N from Supports must land on Mesh (2026-09 review D17).
    expect(workflowStepForShortcut("n", "supports", { meshStatus: "not_started", studyType: "modal_analysis" })).toBe("mesh");
    expect(workflowStepForShortcut("b", "mesh", { meshStatus: "not_started", studyType: "modal_analysis" })).toBe("supports");
    expect(workflowStepForShortcut("n", "supports", { meshStatus: "not_started", studyType: "static_stress" })).toBe("loads");
    expect(workflowStepForShortcut("n", "mesh", { meshStatus: "complete" })).toBe("run");
    // N from Mesh opens Run even before meshing, where the checklist explains the block.
    expect(workflowStepForShortcut("n", "mesh", { meshStatus: "ready" })).toBe("run");
    expect(workflowStepForShortcut("b", "model", { meshStatus: "complete" })).toBeNull();
    expect(workflowStepForShortcut("n", "results", { meshStatus: "complete" })).toBeNull();
  });

  test("ignores single-key shortcuts while editing form fields", () => {
    expect(isEditableShortcutTarget({ tagName: "INPUT", isContentEditable: false })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "SELECT", isContentEditable: false })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(isEditableShortcutTarget(null)).toBe(false);
  });

  test("uses draft print direction for viewer preview before material is applied", () => {
    expect(printLayerOrientationForViewer("z", "x")).toBe("x");
    expect(printLayerOrientationForViewer("z", null)).toBeNull();
    expect(printLayerOrientationForViewer("z", undefined)).toBe("z");
  });
});
