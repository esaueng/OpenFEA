// Browser harness for the solve-ladder benchmark (plan 036 R5.1). Flag-gated
// like solveBenchHarness: main.tsx lazy-imports this chunk only in
// VITE_BROWSER_PROOF=1 / dev builds when the URL carries ?solveLadder, so
// release bundles never contain it.
//
// ?solveLadder=1&case=<shape>-<order>-<rung>-<analysis> runs ONE case in a fresh
// dedicated worker (scripts/verify-solve-ladder.mjs launches a fresh browser
// per case so process memory peaks are per case). The main thread only
// orchestrates and, when the page is cross-origin isolated, samples
// performance.measureUserAgentSpecificMemory(), which covers the worker too.
import { ladderCaseId, type LadderCaseRequest, type LadderCaseResult } from "./solveLadderRun";
import { ladderCases } from "./solveLadderFixtures";

const UA_MEMORY_SAMPLE_INTERVAL_MS = 1000;

export type SolveLadderPageResult = {
  userAgent: string;
  crossOriginIsolated: boolean;
  hardwareConcurrency?: number;
  result: LadderCaseResult;
  wallMs: number;
  uaMemory: { method: string; peakBytes?: number; samples: number };
};

declare global {
  interface Window {
    __openfeaSolveLadder?: {
      phase: "loading" | "running" | "done";
      lastResult?: SolveLadderPageResult;
    };
  }
}

window.__openfeaSolveLadder = { phase: "loading" };

async function measureUaMemoryBytes(): Promise<number | undefined> {
  const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes?: number }> })
    .measureUserAgentSpecificMemory;
  if (typeof measure !== "function" || !window.crossOriginIsolated) return undefined;
  try {
    const measured = await measure.call(performance);
    return typeof measured?.bytes === "number" ? measured.bytes : undefined;
  } catch {
    return undefined;
  }
}

export async function runSolveLadderCase(request: LadderCaseRequest): Promise<SolveLadderPageResult> {
  const uaSupported = typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory === "function"
    && window.crossOriginIsolated;
  const uaMemory: SolveLadderPageResult["uaMemory"] = {
    method: uaSupported
      ? "performance.measureUserAgentSpecificMemory (main thread, includes workers; sampled ~1 s, resolves at GC)"
      : "unavailable (needs Chromium + cross-origin isolation)",
    samples: 0
  };
  let running = true;
  const sampler = (async () => {
    while (running && uaSupported) {
      const bytes = await measureUaMemoryBytes();
      if (bytes !== undefined) {
        uaMemory.samples += 1;
        if (uaMemory.peakBytes === undefined || bytes > uaMemory.peakBytes) uaMemory.peakBytes = bytes;
      }
      await new Promise((resolve) => setTimeout(resolve, UA_MEMORY_SAMPLE_INTERVAL_MS));
    }
  })();
  const started = performance.now();
  const worker = new Worker(new URL("./solveLadderWorker.ts", import.meta.url), { type: "module", name: "openfea-solve-ladder-worker" });
  try {
    const result = await new Promise<LadderCaseResult>((resolve) => {
      worker.addEventListener("message", (event: MessageEvent<{ kind: string; result: LadderCaseResult }>) => {
        if (event.data?.kind === "result") resolve(event.data.result);
      });
      worker.addEventListener("error", (event) => {
        resolve({ ok: false, caseId: ladderCaseId(request), analysis: request.analysis, error: `Worker error: ${event.message || "unknown (likely out of memory)"}` });
      });
      worker.postMessage({ kind: "run", request });
    });
    const wallMs = performance.now() - started;
    running = false;
    await sampler;
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated,
      ...(typeof navigator.hardwareConcurrency === "number" ? { hardwareConcurrency: navigator.hardwareConcurrency } : {}),
      result,
      wallMs,
      uaMemory
    };
  } finally {
    running = false;
    worker.terminate();
  }
}

const params = new URLSearchParams(window.location.search);
const caseParam = params.get("case");
const requested = ladderCases().find((entry) => ladderCaseId(entry) === caseParam);
if (params.get("solveLadder") === "1") {
  if (!requested) {
    window.__openfeaSolveLadder.lastResult = {
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated,
      result: { ok: false, caseId: caseParam ?? "", analysis: "static", error: `Unknown ladder case "${caseParam}".` },
      wallMs: 0,
      uaMemory: { method: "unavailable", samples: 0 }
    };
    window.__openfeaSolveLadder.phase = "done";
  } else {
    window.__openfeaSolveLadder.phase = "running";
    void runSolveLadderCase(requested).then((pageResult) => {
      window.__openfeaSolveLadder!.lastResult = pageResult;
      window.__openfeaSolveLadder!.phase = "done";
      document.title = `SOLVELADDER ${pageResult.result.ok ? "OK" : "FAIL"} ${pageResult.result.caseId}`;
    });
  }
}
