import { describe, expect, test, vi } from "vitest";
import type { ResultField } from "@openfea/schema";
import type { ResultMode, StressComponent, ViewMode } from "../workspaceViewTypes";
import { BOUNDARY_CAPTURE_REVISION, REPORT_CAPTURE_REVISION, reportCapturesAreCurrent, captureResultViews, createCaptureQueue, peakResultField } from "./captureResultViews";

const staticFields = [
  { id: "stress", runId: "run", type: "stress", location: "node", values: [1], min: 1, max: 1, units: "MPa" },
  { id: "displacement", runId: "run", type: "displacement", location: "node", values: [1], min: 1, max: 1, units: "mm" }
] satisfies ResultField[];

const dynamicFields = [
  { id: "stress-surface-0", runId: "run", type: "stress", location: "node", surfaceMeshRef: "surface", values: [0, 1], min: 0, max: 90, units: "MPa", frameIndex: 0, timeSeconds: 0 },
  { id: "stress-surface-1", runId: "run", type: "stress", location: "node", surfaceMeshRef: "surface", values: [0, 90], min: 0, max: 90, units: "MPa", frameIndex: 1, timeSeconds: 0.05 },
  { id: "stress-face-0", runId: "run", type: "stress", location: "face", values: [999], min: 0, max: 999, units: "MPa", frameIndex: 0, timeSeconds: 0 },
  { id: "displacement-surface-0", runId: "run", type: "displacement", location: "node", surfaceMeshRef: "surface", values: [0, 3], min: 0, max: 7, units: "mm", frameIndex: 0, timeSeconds: 0 },
  { id: "displacement-surface-1", runId: "run", type: "displacement", location: "node", surfaceMeshRef: "surface", values: [0, 5], min: 0, max: 7, units: "mm", frameIndex: 1, timeSeconds: 0.05 },
  { id: "displacement-surface-2", runId: "run", type: "displacement", location: "node", surfaceMeshRef: "surface", values: [0, 7], min: 0, max: 7, units: "mm", frameIndex: 2, timeSeconds: 0.1 }
] satisfies ResultField[];

const thermalFields = [
  { id: "temperature", runId: "run", type: "temperature", location: "node", values: [20, 85], min: 20, max: 85, units: "°C" },
  { id: "heat-flux", runId: "run", type: "heat_flux", location: "face", values: [0, 12], min: 0, max: 12, units: "W/m²" }
] satisfies ResultField[];

function pendingFrame() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { arrived, release, wait: () => { arrive(); return pending; } };
}

describe("captureResultViews", () => {
  test("rejects legacy blue screenshots and outdated thermal boundary captures", () => {
    const figures = { stress: { png: "png", fieldId: "stress", selection: "static" as const }, displacement: { png: "png", fieldId: "displacement", selection: "static" as const } };
    expect(reportCapturesAreCurrent(figures, staticFields, false)).toBe(false);
    expect(reportCapturesAreCurrent({ ...figures, revision: REPORT_CAPTURE_REVISION }, staticFields, false)).toBe(true);
    expect(reportCapturesAreCurrent({ ...figures, revision: REPORT_CAPTURE_REVISION, boundary: { png: "png", revision: 3 } }, staticFields, true)).toBe(false);
    expect(reportCapturesAreCurrent({ ...figures, revision: REPORT_CAPTURE_REVISION, boundary: { png: "png", revision: BOUNDARY_CAPTURE_REVISION } }, staticFields, true)).toBe(true);
  });

  test.each([true, false])("uses von Mises for reports even when a larger principal measure is selected (getter: %s)", async (hasGetter) => {
    let component: StressComponent = "principal_max";
    let mode: ResultMode = "stress";
    let frameIndex = 0;
    const captures = await captureResultViews({
      getViewMode: () => "results", getResultMode: () => mode, setResultMode: (next) => { mode = next; },
      ...(hasGetter ? { getStressComponent: () => component } : {}), setStressComponent: (next) => { component = next; },
      getResultFrameIndex: () => frameIndex, setResultFrameIndex: (next) => { frameIndex = next; }, getPlaybackPlaying: () => false, setPlaybackPlaying: () => {},
      resultFields: [...dynamicFields, { ...dynamicFields[0]!, id: "principal-peak", component: "principal_max", values: [999, 1000] }],
      surfaceMeshRef: "surface", capture: () => `data:image/png;base64,${component}`, isCurrent: () => true, waitForAnimationFrame: async () => {}
    });
    expect(captures.stress?.fieldId).toBe("stress-surface-1");
    expect(captures.stress?.png).toBe("data:image/png;base64,von_mises");
    expect(component).toBe(hasGetter ? "principal_max" : "von_mises");
  });
  test("serializes automatic and manual capture tasks and continues after failures", async () => {
    const queue = createCaptureQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = queue.enqueue(async () => {
      events.push("automatic-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      events.push("automatic-end");
    });
    const second = queue.enqueue(async () => {
      events.push("manual-start");
      throw new Error("capture failed");
    });
    const third = queue.enqueue(() => events.push("next-start"));

    await Promise.resolve();
    expect(events).toEqual(["automatic-start"]);
    releaseFirst!();
    await first;
    await expect(second).rejects.toThrow("capture failed");
    await third;
    expect(events).toEqual(["automatic-start", "automatic-end", "manual-start", "next-start"]);
  });

  test("captures each result at its rendered peak frame, then restores viewer state", async () => {
    let mode: ResultMode = "safety_factor";
    let frameIndex = 0;
    let playing = true;
    const setResultMode = vi.fn((next: ResultMode) => { mode = next; });
    const setResultFrameIndex = vi.fn((next: number) => { frameIndex = next; });
    const setPlaybackPlaying = vi.fn((next: boolean) => { playing = next; });
    const capture = vi.fn(async () => `data:image/png;base64,${mode}-${frameIndex}`);
    const waitForAnimationFrame = vi.fn(async () => undefined);

    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode,
      getResultFrameIndex: () => frameIndex,
      setResultFrameIndex,
      getPlaybackPlaying: () => playing,
      setPlaybackPlaying,
      resultFields: dynamicFields,
      surfaceMeshRef: "surface",
      capture,
      isCurrent: () => true,
      waitForAnimationFrame
    });

    expect(result).toEqual({
      revision: REPORT_CAPTURE_REVISION,
      stress: {
        png: "data:image/png;base64,stress-1",
        fieldId: "stress-surface-1",
        selection: "peak",
        frameIndex: 1,
        timeSeconds: 0.05
      },
      displacement: {
        png: "data:image/png;base64,displacement-2",
        fieldId: "displacement-surface-2",
        selection: "peak",
        frameIndex: 2,
        timeSeconds: 0.1
      }
    });
    expect(setResultMode.mock.calls.map(([next]) => next)).toEqual(["stress", "displacement", "safety_factor"]);
    expect(setResultFrameIndex.mock.calls.map(([next]) => next)).toEqual([1, 2, 0]);
    expect(setPlaybackPlaying.mock.calls.map(([next]) => next)).toEqual([false, true]);
    expect(waitForAnimationFrame).toHaveBeenCalledTimes(4);
  });

  test("skips absent fields and reports a stale result capture", async () => {
    let current = true;
    let mode: "stress" | "displacement" = "stress";
    let frameIndex = 4;
    await expect(captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next as typeof mode; },
      getResultFrameIndex: () => frameIndex,
      setResultFrameIndex: (next) => { frameIndex = next; },
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: staticFields.slice(0, 1),
      capture: () => "data:image/png;base64,stress",
      isCurrent: () => current,
      waitForAnimationFrame: async () => { current = false; }
    })).rejects.toThrow("Results changed while the report figures were being captured");
    expect(mode).toBe("stress");
    expect(frameIndex).toBe(4);
  });

  test("captures the boundary-condition view in model view and restores results view", async () => {
    let mode: ResultMode = "stress";
    const viewModes: ("model" | null)[] = [];
    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: staticFields,
      capture: () => `data:image/png;base64,${viewModes.at(-1) === "model" ? "boundary" : mode}`,
      isCurrent: () => true,
      waitForAnimationFrame: async () => undefined,
      setCaptureViewMode: (next) => { viewModes.push(next); },
      captureBoundaryView: true
    });

    expect(result.boundary).toEqual({ png: "data:image/png;base64,boundary", revision: BOUNDARY_CAPTURE_REVISION });
    expect(viewModes).toEqual(["model", null]);
  });

  test("boundary-only modal capture preserves phase and mode changes made while its frames are pending", async () => {
    const fields: ResultField[] = [{
      id: "mode-1", runId: "run-modal", type: "mode_shape", location: "node",
      values: [1], vectors: [[1, 0, 0]], min: 0, max: 1, units: "normalized",
      modeIndex: 1, frequencyHz: 100, eigenvalue: 394_784, scaledResidual: 1e-8
    }];
    const canonicalFields = structuredClone(fields);
    // A boundary-only capture must not own the current result-mode selection.
    let mode: ResultMode = "displacement";
    let frameIndex = 0;
    let captureViewMode: "model" | null = null;
    const firstFrame = pendingFrame();
    const secondFrame = pendingFrame();
    const waitForAnimationFrame = vi.fn()
      .mockImplementationOnce(firstFrame.wait)
      .mockImplementationOnce(secondFrame.wait);
    const setResultMode = vi.fn((next: ResultMode) => { mode = next; });
    const setResultFrameIndex = vi.fn((next: number) => { frameIndex = next; });
    const viewModes: ("model" | null)[] = [];
    const capture = vi.fn(() => {
      expect(captureViewMode).toBe("model");
      return "data:image/png;base64,boundary";
    });
    const pendingCapture = captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode,
      getResultFrameIndex: () => frameIndex,
      setResultFrameIndex,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: fields,
      capture,
      isCurrent: () => true,
      waitForAnimationFrame,
      setCaptureViewMode: (next) => { captureViewMode = next; viewModes.push(next); },
      captureBoundaryView: true
    });

    await firstFrame.arrived;
    expect(capture).not.toHaveBeenCalled();
    firstFrame.release();
    await secondFrame.arrived;
    expect(capture).not.toHaveBeenCalled();
    expect(setResultFrameIndex).not.toHaveBeenCalled();
    expect(setResultMode).not.toHaveBeenCalled();
    // The user selects the modal display and half-cycle phase before capture ends.
    mode = "mode_shape";
    frameIndex = 12;
    secondFrame.release();
    const result = await pendingCapture;

    expect({ mode, frameIndex }).toEqual({ mode: "mode_shape", frameIndex: 12 });
    expect(result).toEqual({
      revision: REPORT_CAPTURE_REVISION,
      boundary: { png: "data:image/png;base64,boundary", revision: BOUNDARY_CAPTURE_REVISION }
    });
    expect(reportCapturesAreCurrent(result, fields, true)).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
    expect(waitForAnimationFrame).toHaveBeenCalledTimes(2);
    expect(viewModes).toEqual(["model", null]);
    expect(captureViewMode).toBeNull();
    expect(fields).toEqual(canonicalFields);
  });

  test.each(["mode", "frame", "component", "playback"] as const)("rejects a peak figure when the user changes its %s before capture", async (changed) => {
    let mode: ResultMode = "displacement";
    let frameIndex = 0;
    let component: StressComponent = "principal_max";
    let playing = true;
    const frame = pendingFrame();
    const capture = vi.fn(() => "data:image/png;base64,wrong-view");
    const fields = structuredClone(dynamicFields);
    const pending = captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode, setResultMode: (next) => { mode = next; },
      getStressComponent: () => component, setStressComponent: (next) => { component = next; },
      getResultFrameIndex: () => frameIndex, setResultFrameIndex: (next) => { frameIndex = next; },
      getPlaybackPlaying: () => playing, setPlaybackPlaying: (next) => { playing = next; },
      resultFields: fields, surfaceMeshRef: "surface", capture, isCurrent: () => true,
      waitForAnimationFrame: vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(frame.wait)
    });
    await frame.arrived;
    expect({ mode, frameIndex, component, playing }).toEqual({ mode: "stress", frameIndex: 1, component: "von_mises", playing: false });
    if (changed === "mode") mode = "velocity";
    if (changed === "frame") frameIndex = 12;
    if (changed === "component") component = "principal_min";
    if (changed === "playback") playing = true;
    const rejection = expect(pending).rejects.toThrow("Results changed while the report figures were being captured");
    frame.release();
    await rejection;
    expect(capture).not.toHaveBeenCalled();
    expect({ mode, frameIndex, component, playing }).toEqual({
      mode: changed === "mode" ? "velocity" : "displacement",
      frameIndex: changed === "frame" ? 12 : 0,
      component: changed === "component" ? "principal_min" : "principal_max",
      playing: true
    });
    expect(fields).toEqual(dynamicFields);
  });

  test("rejects a view change while the screenshot promise is pending", async () => {
    let mode: ResultMode = "displacement";
    let frameIndex = 0;
    const screenshot = pendingFrame();
    const pending = captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode, setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => frameIndex, setResultFrameIndex: (next) => { frameIndex = next; },
      getPlaybackPlaying: () => false, setPlaybackPlaying: () => undefined,
      resultFields: dynamicFields, surfaceMeshRef: "surface", isCurrent: () => true,
      waitForAnimationFrame: async () => undefined,
      capture: async () => { await screenshot.wait(); return "data:image/png;base64,stale"; }
    });
    await screenshot.arrived;
    frameIndex = 12;
    const rejection = expect(pending).rejects.toThrow("Results changed while the report figures were being captured");
    screenshot.release();
    await rejection;
    expect({ mode, frameIndex }).toEqual({ mode: "displacement", frameIndex: 12 });
  });

  test.each(["frame", "screenshot"] as const)("rejects playback started from paused while a peak %s is pending", async (pendingStage) => {
    let mode: ResultMode = "displacement";
    let frameIndex = 0;
    let playing = false;
    const barrier = pendingFrame();
    const capture = vi.fn(async () => {
      if (pendingStage === "screenshot") await barrier.wait();
      return "data:image/png;base64,animating-view";
    });
    const setPlaybackPlaying = vi.fn((next: boolean) => { playing = next; });
    const pending = captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode, setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => frameIndex, setResultFrameIndex: (next) => { frameIndex = next; },
      getPlaybackPlaying: () => playing, setPlaybackPlaying,
      resultFields: dynamicFields, surfaceMeshRef: "surface", isCurrent: () => true, capture,
      waitForAnimationFrame: pendingStage === "frame" ? barrier.wait : async () => undefined
    });
    await barrier.arrived;
    expect({ mode, frameIndex, playing }).toEqual({ mode: "stress", frameIndex: 1, playing: false });
    // The renderer can animate fractional positions without changing this
    // discrete frame index; a matching frame alone cannot prove the PNG's phase.
    playing = true;
    const rejection = expect(pending).rejects.toThrow("Results changed while the report figures were being captured");
    barrier.release();
    await rejection;
    expect({ mode, frameIndex, playing }).toEqual({ mode: "displacement", frameIndex: 0, playing: true });
    expect(setPlaybackPlaying).not.toHaveBeenCalled();
    if (pendingStage === "frame") expect(capture).not.toHaveBeenCalled();
    else expect(capture).toHaveBeenCalledOnce();
  });

  test("does not restore old selections into a replacement run even when their values match", async () => {
    let current = true;
    let mode: ResultMode = "displacement";
    let frameIndex = 0;
    let component: StressComponent = "principal_max";
    let playing = true;
    const frame = pendingFrame();
    const setResultMode = vi.fn((next: ResultMode) => { mode = next; });
    const setResultFrameIndex = vi.fn((next: number) => { frameIndex = next; });
    const setStressComponent = vi.fn((next: StressComponent) => { component = next; });
    const setPlaybackPlaying = vi.fn((next: boolean) => { playing = next; });
    const capture = vi.fn(() => "unused");
    const pending = captureResultViews({
      getViewMode: () => "results", getResultMode: () => mode, setResultMode,
      getStressComponent: () => component, setStressComponent,
      getResultFrameIndex: () => frameIndex, setResultFrameIndex,
      getPlaybackPlaying: () => playing, setPlaybackPlaying,
      resultFields: dynamicFields, surfaceMeshRef: "surface", capture,
      isCurrent: () => current, waitForAnimationFrame: frame.wait
    });
    await frame.arrived;
    current = false;
    // These same values now belong to the newly loaded run, not this capture.
    const replacement = { mode, frameIndex, component, playing };
    for (const setter of [setResultMode, setResultFrameIndex, setStressComponent, setPlaybackPlaying]) setter.mockClear();
    const rejection = expect(pending).rejects.toThrow("Results changed while the report figures were being captured");
    frame.release();
    await rejection;
    expect({ mode, frameIndex, component, playing }).toEqual(replacement);
    for (const setter of [setResultMode, setResultFrameIndex, setStressComponent, setPlaybackPlaying]) expect(setter).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  test.each(["navigation", "new run", "capture failure"] as const)("clears the boundary override after %s without changing the user's view or selections", async (change) => {
    let viewMode: ViewMode = "results";
    let captureViewMode: "model" | null = null;
    let current = true;
    let mode: ResultMode = "mode_shape";
    let frameIndex = 0;
    const frame = pendingFrame();
    const setResultMode = vi.fn((next: ResultMode) => { mode = next; });
    const setResultFrameIndex = vi.fn((next: number) => { frameIndex = next; });
    const capture = vi.fn(() => { throw new Error("capture unavailable"); });
    const pending = captureResultViews({
      getViewMode: () => viewMode, getResultMode: () => mode, setResultMode,
      getResultFrameIndex: () => frameIndex, setResultFrameIndex,
      getPlaybackPlaying: () => false, setPlaybackPlaying: () => undefined,
      resultFields: [], capture, isCurrent: () => current,
      waitForAnimationFrame: vi.fn().mockImplementationOnce(frame.wait).mockResolvedValue(undefined),
      setCaptureViewMode: (next) => { captureViewMode = next; }, captureBoundaryView: true
    });
    await frame.arrived;
    expect(captureViewMode).toBe("model");
    if (change === "navigation") viewMode = "mesh";
    if (change === "new run") current = false;
    mode = "velocity";
    frameIndex = 12;
    const rejection = expect(pending).rejects.toThrow(change === "capture failure" ? "capture unavailable" : "Results changed while the report figures were being captured");
    frame.release();
    await rejection;
    expect(captureViewMode).toBeNull();
    expect(viewMode).toBe(change === "navigation" ? "mesh" : "results");
    expect({ mode, frameIndex }).toEqual({ mode: "velocity", frameIndex: 12 });
    expect(setResultMode).not.toHaveBeenCalled();
    expect(setResultFrameIndex).not.toHaveBeenCalled();
    if (change !== "capture failure") expect(capture).not.toHaveBeenCalled();
  });

  test("restores capture-owned selections after a screenshot failure", async () => {
    let mode: ResultMode = "displacement";
    let frameIndex = 0;
    let component: StressComponent = "principal_max";
    let playing = true;
    await expect(captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode, setResultMode: (next) => { mode = next; },
      getStressComponent: () => component, setStressComponent: (next) => { component = next; },
      getResultFrameIndex: () => frameIndex, setResultFrameIndex: (next) => { frameIndex = next; },
      getPlaybackPlaying: () => playing, setPlaybackPlaying: (next) => { playing = next; },
      resultFields: dynamicFields, surfaceMeshRef: "surface", isCurrent: () => true,
      waitForAnimationFrame: async () => undefined,
      capture: () => { throw new Error("capture unavailable"); }
    })).rejects.toThrow("capture unavailable");
    expect({ mode, frameIndex, component, playing }).toEqual({ mode: "displacement", frameIndex: 0, component: "principal_max", playing: true });
  });

  test("clears the boundary override when the capture finds stale results", async () => {
    const viewModes: ("model" | null)[] = [];
    let framesWaited = 0;
    await expect(captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => "stress",
      setResultMode: () => undefined,
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: [],
      capture: () => "data:image/png;base64,unused",
      // Stale only after the boundary capture's frame waits begin.
      isCurrent: () => framesWaited < 1,
      waitForAnimationFrame: async () => { framesWaited += 1; },
      setCaptureViewMode: (next) => { viewModes.push(next); },
      captureBoundaryView: true
    })).rejects.toThrow("Results changed while the report figures were being captured");
    expect(viewModes).toEqual(["model", null]);
  });

  test("returns static capture metadata when the result has no transient frames", async () => {
    let mode: ResultMode = "stress";
    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: staticFields,
      capture: () => `data:image/png;base64,${mode}`,
      isCurrent: () => true,
      waitForAnimationFrame: async () => undefined
    });

    expect(result.stress).toMatchObject({ fieldId: "stress", selection: "static" });
    expect(result.displacement).toMatchObject({ fieldId: "displacement", selection: "static" });
  });

  test("captures thermal temperature and heat-flux figures into the report figure slots", async () => {
    let mode: ResultMode = "temperature";
    const result = await captureResultViews({
      getViewMode: () => "results",
      getResultMode: () => mode,
      setResultMode: (next) => { mode = next; },
      getResultFrameIndex: () => 0,
      setResultFrameIndex: () => undefined,
      getPlaybackPlaying: () => false,
      setPlaybackPlaying: () => undefined,
      resultFields: thermalFields,
      capture: () => `data:image/png;base64,${mode}`,
      isCurrent: () => true,
      waitForAnimationFrame: async () => undefined
    });

    expect(result.stress).toMatchObject({ fieldId: "temperature", png: "data:image/png;base64,temperature" });
    expect(result.displacement).toMatchObject({ fieldId: "heat-flux", png: "data:image/png;base64,heat_flux" });
  });
});

describe("peakResultField", () => {
  test("uses the field actually rendered on the solver surface and its active values", () => {
    expect(peakResultField(dynamicFields, "stress", "surface")?.id).toBe("stress-surface-1");
    expect(peakResultField(dynamicFields, "displacement", "surface")?.id).toBe("displacement-surface-2");
  });
});
