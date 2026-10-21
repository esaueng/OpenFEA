import type { ResultField } from "@openfea/schema";
import type { ResultMode, StressComponent, ViewMode } from "../workspaceViewTypes";

export interface ResultViewCaptures {
  revision?: number;
  stress?: CapturedResultView;
  displacement?: CapturedResultView;
  boundary?: CapturedBoundaryView;
}

export interface CapturedResultView {
  png: string;
  fieldId: string;
  selection: "peak" | "static";
  frameIndex?: number;
  timeSeconds?: number;
}

export interface CapturedBoundaryView {
  png: string;
  /** Bump BOUNDARY_CAPTURE_REVISION when the figure's framing/styling changes so saved runs recapture. */
  revision?: number;
}

// Revision 4: thermal input labels identify heat instead of force. Preserve
// the hidden dimensions and content crop introduced in revision 3.
export const BOUNDARY_CAPTURE_REVISION = 4;
// Older captures can contain neutral contours from a discarded surface mesh.
export const REPORT_CAPTURE_REVISION = 1;

export interface CaptureQueue {
  enqueue: <T>(task: () => T | Promise<T>) => Promise<T>;
}

export function createCaptureQueue(): CaptureQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue: <T>(task: () => T | Promise<T>) => {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

export interface CaptureResultViewsOptions {
  getViewMode: () => ViewMode;
  getResultMode: () => ResultMode;
  setResultMode: (mode: ResultMode) => void;
  getStressComponent?: () => StressComponent;
  setStressComponent?: (component: StressComponent) => void;
  getResultFrameIndex: () => number;
  setResultFrameIndex: (frameIndex: number) => void;
  getPlaybackPlaying: () => boolean;
  setPlaybackPlaying: (playing: boolean) => void;
  resultFields: ResultField[];
  surfaceMeshRef?: string;
  capture: (() => string | Promise<string>) | null;
  isCurrent: () => boolean;
  waitForAnimationFrame?: () => Promise<void>;
  /** Temporary report-only override; clearing it reveals the user's current view. */
  setCaptureViewMode?: (mode: "model" | null) => void;
  /** Capture a model-view snapshot of the support/load markers for the report's boundary-conditions figure. */
  captureBoundaryView?: boolean;
  /**
   * Resolves once the model view has real geometry to photograph. Uploaded
   * STEP previews remount and re-tessellate when leaving the results view, so
   * a fixed frame wait would capture an empty scene.
   */
  waitForBoundaryViewReady?: () => Promise<void>;
}

const REPORT_RESULT_CAPTURES = [
  { mode: "stress", slot: "stress" },
  { mode: "displacement", slot: "displacement" },
  // The report data contract has two primary figure slots. Thermal reports
  // intentionally reuse them for temperature and heat flux respectively.
  { mode: "temperature", slot: "stress" },
  { mode: "heat_flux", slot: "displacement" }
] as const satisfies ReadonlyArray<{ mode: ResultMode; slot: "stress" | "displacement" }>;

export function reportCapturesAreCurrent(captures: ResultViewCaptures | null | undefined, fields: ResultField[], includeBoundary: boolean): boolean {
  return captures?.revision === REPORT_CAPTURE_REVISION
    && REPORT_RESULT_CAPTURES.every(({ mode, slot }) => !fields.some((field) => field.type === mode) || Boolean(captures[slot]))
    && (!includeBoundary || captures.boundary?.revision === BOUNDARY_CAPTURE_REVISION);
}

export async function captureResultViews(options: CaptureResultViewsOptions): Promise<ResultViewCaptures> {
  if (options.getViewMode() !== "results") {
    throw new Error("Open the Results view before generating a report.");
  }

  const availableCaptures = REPORT_RESULT_CAPTURES.filter(({ mode }) => options.resultFields.some((field) => field.type === mode));
  const captureBoundary = Boolean(options.captureBoundaryView && options.setCaptureViewMode);
  if ((availableCaptures.length || captureBoundary) && !options.capture) {
    throw new Error("The 3D result view is still loading. Wait for it to appear, then generate the report again.");
  }

  const originalMode = options.getResultMode();
  const originalStressComponent = options.getStressComponent?.();
  const originalFrameIndex = options.getResultFrameIndex();
  const originalPlaybackPlaying = options.getPlaybackPlaying();
  const waitForFrame = options.waitForAnimationFrame ?? nextAnimationFrame;
  const captures: ResultViewCaptures = { revision: REPORT_CAPTURE_REVISION };
  let capturedMode: ResultMode | undefined;
  let capturedStressComponent: StressComponent | undefined;
  let capturedFrameIndex: number | undefined;
  let pausedPlayback = false;
  const assertCaptureOwned = () => {
    assertCurrent(options);
    if ((capturedMode !== undefined && options.getResultMode() !== capturedMode)
      || (capturedStressComponent !== undefined && options.getStressComponent?.() !== capturedStressComponent)
      || (capturedFrameIndex !== undefined && options.getResultFrameIndex() !== capturedFrameIndex)
      || (pausedPlayback && options.getPlaybackPlaying())) {
      throw staleResultsError();
    }
  };

  try {
    assertCurrent(options);
    if (originalPlaybackPlaying && availableCaptures.length) {
      options.setPlaybackPlaying(false);
      pausedPlayback = true;
    }
    for (const { mode, slot } of availableCaptures) {
      assertCurrent(options);
      const peakField = peakResultField(options.resultFields, mode, options.surfaceMeshRef);
      if (!peakField) continue;
      options.setResultMode(mode);
      capturedMode = mode;
      if (mode === "stress" && options.setStressComponent && options.getStressComponent) {
        options.setStressComponent("von_mises");
        capturedStressComponent = "von_mises";
      }
      if (peakField.frameIndex !== undefined) {
        options.setResultFrameIndex(peakField.frameIndex);
        capturedFrameIndex = peakField.frameIndex;
      }
      await waitForFrame();
      assertCaptureOwned();
      await waitForFrame();
      assertCaptureOwned();
      const png = await options.capture!();
      assertCaptureOwned();
      captures[slot] = {
        png,
        fieldId: peakField.id,
        selection: peakField.frameIndex === undefined ? "static" : "peak",
        ...(peakField.frameIndex === undefined ? {} : { frameIndex: peakField.frameIndex }),
        ...(peakField.timeSeconds === undefined ? {} : { timeSeconds: peakField.timeSeconds })
      };
    }
    if (captureBoundary) {
      captures.boundary = await captureBoundaryView(options, waitForFrame, assertCaptureOwned);
    }
    return captures;
  } finally {
    // A capture may span user input or a new run. Restore only settings this
    // capture changed and still owns; boundary-only captures own no selection.
    if (options.isCurrent() && options.getViewMode() === "results") {
      if (capturedFrameIndex !== undefined && options.getResultFrameIndex() === capturedFrameIndex) options.setResultFrameIndex(originalFrameIndex);
      if (capturedMode !== undefined && options.getResultMode() === capturedMode) options.setResultMode(originalMode);
      if (capturedStressComponent !== undefined && options.getStressComponent?.() === capturedStressComponent && originalStressComponent) options.setStressComponent?.(originalStressComponent);
      if (pausedPlayback && !options.getPlaybackPlaying()) options.setPlaybackPlaying(true);
    }
  }
}

// The boundary markers (supports + loads) only render outside the results
// view, so temporarily override the viewer without changing the user's view.
async function captureBoundaryView(options: CaptureResultViewsOptions, waitForFrame: () => Promise<void>, assertCaptureOwned: () => void): Promise<CapturedBoundaryView> {
  assertCaptureOwned();
  options.setCaptureViewMode!("model");
  try {
    await options.waitForBoundaryViewReady?.();
    assertCaptureOwned();
    await waitForFrame();
    assertCaptureOwned();
    await waitForFrame();
    assertCaptureOwned();
    const png = await options.capture!();
    assertCaptureOwned();
    return { png, revision: BOUNDARY_CAPTURE_REVISION };
  } finally {
    options.setCaptureViewMode!(null);
  }
}

export function peakResultField(fields: ResultField[], mode: "stress" | "displacement" | "temperature" | "heat_flux", surfaceMeshRef?: string): ResultField | undefined {
  const modeFields = fields.filter((field) => field.type === mode && (mode !== "stress" || (field.component ?? "von_mises") === "von_mises"));
  if (!modeFields.length) return undefined;

  const surfaceFields = surfaceMeshRef
    ? modeFields.filter((field) => field.location === "node" && field.surfaceMeshRef === surfaceMeshRef)
    : [];
  const faceFields = modeFields.filter((field) => field.location === "face");
  const sampledFields = modeFields.filter((field) => field.samples?.length);
  const candidates = surfaceFields.length
    ? surfaceFields
    : faceFields.length
      ? faceFields
      : sampledFields.length
        ? sampledFields
        : modeFields;

  return candidates
    .map((field) => ({ field, magnitude: fieldPeakMagnitude(field) }))
    .reduce((peak, candidate) => candidate.magnitude > peak.magnitude ? candidate : peak)
    .field;
}

function fieldPeakMagnitude(field: ResultField): number {
  let peak = Number.NEGATIVE_INFINITY;
  for (const value of field.values) {
    if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
  }
  for (const sample of field.samples ?? []) {
    if (Number.isFinite(sample.value)) peak = Math.max(peak, Math.abs(sample.value));
  }
  if (Number.isFinite(peak)) return peak;
  return Math.max(Math.abs(Number(field.min) || 0), Math.abs(Number(field.max) || 0));
}

function assertCurrent(options: Pick<CaptureResultViewsOptions, "getViewMode" | "isCurrent">): void {
  if (options.getViewMode() !== "results" || !options.isCurrent()) {
    throw staleResultsError();
  }
}

function staleResultsError(): Error {
  return new Error("Results changed while the report figures were being captured. Generate the report again from the current results.");
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
