import type { Study } from "@openfea/schema";
import { AlertTriangle, Anchor, ArrowDownToLine, Box, ChartColumn, Grid3x3, Layers3, Play, type LucideIcon } from "lucide-react";
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

/** Icons stand in for the names where the bar is too narrow for them; Anchor, Grid3x3
 *  and Play match the support marker, the viewer's Mesh toggle and the Run button. */
const steps: ReadonlyArray<{ id: StepId; label: string; icon: LucideIcon }> = [
  { id: "model", label: "Model", icon: Box },
  { id: "material", label: "Material", icon: Layers3 },
  { id: "supports", label: "Supports", icon: Anchor },
  { id: "loads", label: "Loads", icon: ArrowDownToLine },
  { id: "mesh", label: "Mesh", icon: Grid3x3 },
  { id: "run", label: "Run", icon: Play },
  { id: "results", label: "Results", icon: ChartColumn }
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
 * The workflow as a row of step names in the top bar. It replaced the 124px left rail
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
        {visibleSteps.map((step) => {
          const isActive = activeStep === step.id;
          const isComplete = completed[step.id];
          const canSelect = canNavigateToStep(step.id, { meshStatus: study.meshSettings.status });
          const stepBlockers = blockersByStep[step.id];
          const isBlocked = !isComplete && Boolean(stepBlockers?.length);
          const notice = notices[step.id];
          const state = isComplete ? "done" : isBlocked ? "blocked" : "";
          const attention = notice ? `${step.label}: needs attention` : undefined;
          // A blocked step and the step carrying the workspace notice both get a warning
          // glyph after the label; an error notice takes the error tone.
          const flag = notice ?? (isBlocked ? "warning" : null);
          return (
            <li key={step.id} className="step-nav-item">
              {/* State is the bar under the label: present and filled for done, accent for
                  the current step, absent for steps still to do. Presence carries the state,
                  not colour alone. */}
              <button
                type="button"
                className={["step-nav-step", state, isActive && "active"].filter(Boolean).join(" ")}
                disabled={!canSelect}
                onClick={() => onSelect(step.id)}
                aria-current={isActive ? "step" : undefined}
                // Below the wide tier only the current step shows its label, so the title
                // carries the name (or the blocker) on hover for the others.
                title={stepBlockers?.length ? stepBlockers.join(" ") : attention ?? step.label}
                aria-label={stepBlockers?.length ? `${step.label}: ${stepBlockers.join(" ")}` : attention}
              >
                <step.icon className="step-nav-icon" size={16} strokeWidth={1.9} aria-hidden="true" />
                <span className="step-nav-label">{step.label}</span>
                {flag && <AlertTriangle className={`step-nav-flag ${flag}`} size={13} strokeWidth={2.25} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
