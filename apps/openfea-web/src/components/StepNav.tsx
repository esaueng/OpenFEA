import type { Study } from "@openfea/schema";
import { AlertTriangle, Check } from "lucide-react";
import { canNavigateToStep } from "../appShellState";
import type { RunReadinessItem } from "../runReadiness";

export type StepId = "model" | "material" | "supports" | "loads" | "mesh" | "run" | "results";

interface StepNavProps {
  activeStep: StepId;
  study: Study;
  hasResults: boolean;
  onSelect: (step: StepId) => void;
  /** Run-gate rows; a step with a blocker renders as blocked rather than done. */
  readiness?: readonly RunReadinessItem[];
  /** Steps carrying the workspace notice (failed mesh/run, cleared results). */
  notices?: Partial<Record<StepId, "error" | "warning">>;
}

const steps: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: "model", label: "Model" },
  { id: "material", label: "Material" },
  { id: "supports", label: "Supports" },
  { id: "loads", label: "Loads" },
  { id: "mesh", label: "Mesh" },
  { id: "run", label: "Run" },
  { id: "results", label: "Results" }
] as const;

/** Which step owns each readiness row, so the stepper can show a blocked state where the fix lives. */
const READINESS_STEP: Record<string, StepId> = {
  "Material assigned": "material",
  "Support added": "supports",
  "Load added": "loads",
  "Mesh generated": "mesh",
  "Run settings valid": "run",
  "Study valid": "run"
};

export function readinessBlockersByStep(readiness: readonly RunReadinessItem[]): Partial<Record<StepId, string[]>> {
  const blockers: Partial<Record<StepId, string[]>> = {};
  for (const item of readiness) {
    if (item.done || !item.blockers.length) continue;
    const step = READINESS_STEP[item.label] ?? "run";
    blockers[step] = [...(blockers[step] ?? []), ...item.blockers];
  }
  return blockers;
}

/**
 * The workflow as a numbered stepper in the top bar. It replaced the 124px left rail
 * (plan 035, increment 1) and keeps the rail's state rules exactly: done means
 * "present and valid", a step whose readiness row lists a blocker is blocked rather
 * than ticked, and Run/Results tick only for results the viewer can show.
 */
export function StepNav({ activeStep, study, hasResults, readiness = [], notices = {}, onSelect }: StepNavProps) {
  const blockersByStep = readinessBlockersByStep(readiness);
  const completed: Record<StepId, boolean> = {
    model: true,
    material: study.materialAssignments.length > 0 && !blockersByStep.material,
    supports: study.constraints.length > 0 && !blockersByStep.supports,
    loads: (study.type === "modal_analysis" || study.loads.length > 0) && !blockersByStep.loads,
    mesh: study.meshSettings.status === "complete" && !blockersByStep.mesh,
    run: hasResults,
    results: hasResults
  };
  const visibleSteps = steps.filter((step) => study.type !== "modal_analysis" || step.id !== "loads");

  return (
    <nav className="step-nav" aria-label="Simulation workflow">
      <ol className="step-nav-list">
        {visibleSteps.map((step, index) => {
          const isActive = activeStep === step.id;
          const isComplete = completed[step.id];
          const canSelect = canNavigateToStep(step.id, { meshStatus: study.meshSettings.status });
          const stepBlockers = blockersByStep[step.id];
          const isBlocked = !isComplete && Boolean(stepBlockers?.length);
          const notice = notices[step.id];
          const state = isComplete ? "done" : isBlocked ? "blocked" : "";
          return (
            <li key={step.id} className="step-nav-item">
              <button
                type="button"
                className={`step-nav-step ${isActive ? "active" : ""}`}
                disabled={!canSelect}
                onClick={() => onSelect(step.id)}
                aria-current={isActive ? "step" : undefined}
                // Below the wide tier only the current step shows its label, so the title
                // carries the name (or the blocker) on hover for the others.
                title={stepBlockers?.length ? stepBlockers.join(" ") : step.label}
                aria-label={stepBlockers?.length ? `${step.label}: ${stepBlockers.join(" ")}` : notice ? `${step.label}: needs attention` : undefined}
              >
                {/* The number stays in every state: where labels are clipped it is the only
                    visible thing telling the steps apart. Status rides on a glyph badge. */}
                <span className={`step-nav-dot ${state}`} aria-hidden="true">
                  {index + 1}
                  {isComplete ? <span className="step-nav-status"><Check size={9} strokeWidth={3} /></span> : null}
                  {isBlocked ? <span className="step-nav-status"><AlertTriangle size={9} strokeWidth={2.6} /></span> : null}
                  {notice && <i className={`step-badge ${notice}`} />}
                </span>
                <span className="step-nav-label">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
