import { X } from "lucide-react";
import { formatSimulationEta } from "./panels/RunPanel";

interface SolveProgressOverlayProps {
  /** 0–100 as reported by the run. */
  progress: number;
  /** The run's own phase message, e.g. "Meshing geometry" or "Solving 120k DOF". */
  phase: string;
  /** The run's remaining-time estimate, when it has one. */
  estimatedRemainingMs?: number;
  onStop: () => void;
}

/**
 * Solve progress over the viewer, on whatever step is open. A run started from the
 * top bar used to show only "Stop 6%" in the button and "Simulating" in the footer
 * while the panel stayed where it was. The phase line is a polite live region; the
 * percent is a progressbar (not live) so screen readers are not read every tick.
 */
export function SolveProgressOverlay({ progress, phase, estimatedRemainingMs, onStop }: SolveProgressOverlayProps) {
  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  const remaining = formatSimulationEta(estimatedRemainingMs, true);
  return (
    <section className="solve-progress-overlay" aria-label="Simulation progress">
      <div className="solve-progress-copy">
        <strong>Simulating · {percent}%</strong>
        {/* Visible detail (iteration counts, frame counters) changes every tick, so it
            stays out of the live region; only the phase name is announced. */}
        <span aria-hidden="true">{solveDetailText(phase)}</span>
        <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{solvePhaseText(phase)}</span>
        <small>{remaining}</small>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Simulation progress">
        <span style={{ width: `${percent}%` }} />
      </div>
      <button className="secondary" type="button" onClick={onStop}><X size={14} aria-hidden="true" />Stop</button>
    </section>
  );
}

/** The run message without the remaining-time suffix the log lines carry. */
export function solveDetailText(message: string): string {
  const detail = message.replace(/\s*(?:About .* remaining|Almost done)\.?$/u, "").trim();
  return detail || "Starting simulation.";
}

/**
 * The phase alone: no parenthesised iteration/residual detail and no "n / m"
 * counters, so the live region speaks when the phase changes, not every tick.
 */
export function solvePhaseText(message: string): string {
  const phase = solveDetailText(message)
    .replace(/\s*\([^)]*\)/gu, "")
    .replace(/\s+\d[\d,]*(?:\.\d+)?\s*\/\s*\d[\d,]*(?:\.\d+)?/gu, "")
    .replace(/\s+\./gu, ".")
    .trim();
  return phase || "Starting simulation.";
}
