// Dedicated worker for the ?solveLadder harness: generates one deterministic
// ladder fixture and solves it with the production CPU solver, off the main
// thread like a real browser solve.
import { runLadderCase, type LadderCaseRequest, type LadderCaseResult } from "./solveLadderRun";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<{ kind: "run"; request: LadderCaseRequest }>) => void): void;
  postMessage(message: { kind: "result"; result: LadderCaseResult }): void;
};

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (event) => {
  if (event.data?.kind !== "run") return;
  let result: LadderCaseResult;
  try {
    result = runLadderCase(event.data.request);
  } catch (error) {
    result = {
      ok: false,
      caseId: `${event.data.request.shape}-${event.data.request.order.toLowerCase()}-${event.data.request.rung}-${event.data.request.analysis}`,
      analysis: event.data.request.analysis,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    };
  }
  workerScope.postMessage({ kind: "result", result });
});
