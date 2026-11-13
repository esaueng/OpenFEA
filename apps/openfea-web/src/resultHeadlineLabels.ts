import type { StructuralResultSummary } from "@openfea/schema";

export type StructuralHeadlineLabels = {
  stress: string;
  displacement: string;
  safetyFactor: string;
  reactionForce: string;
  /** Prefix for the legend's run-wide peak ("Peak 1.83 MPa"). */
  peak: string;
};

/**
 * What each structural headline number is. A dynamic run's summary holds the
 * peak over every output frame (stress, displacement), the minimum safety
 * factor over time and the last frame's reaction; the legend and frame scrubber
 * show one frame. Under the default ramp load on a stiff part (the Bracket
 * Demo) the peak is the end-of-ramp, full-load frame, so it legitimately
 * matches the static answer to display precision; the label has to say it is a
 * peak over time so it is not read as the static result shown for a dynamic run.
 */
export function structuralHeadlineLabels(summary: Pick<StructuralResultSummary, "transient">): StructuralHeadlineLabels {
  if (!summary.transient) {
    return { stress: "Max stress", displacement: "Max displacement", safetyFactor: "Safety factor", reactionForce: "Reaction force", peak: "Peak" };
  }
  return {
    stress: "Peak stress over time",
    displacement: "Peak displacement over time",
    safetyFactor: "Min safety factor over time",
    reactionForce: "Reaction force, final frame",
    peak: "Peak over time"
  };
}
