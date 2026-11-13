import { validateStudy, type StudyValidationContext } from "@openfea/study-core";
import type { CustomMaterial, Diagnostic, Study } from "@openfea/schema";

export interface RunReadinessItem {
  /** Stable row key (the stepper maps rows to steps by it); not always the copy shown. */
  label: string;
  /** User-facing row text when it differs from `label`, e.g. thermal vocabulary. */
  displayLabel?: string;
  done: boolean;
  /** Validator messages that keep this item from being done. */
  blockers: string[];
  /**
   * Set when the row is not done but does not block the run: the work happens as
   * part of the run itself (a mesh built on demand). Shown unticked with this note.
   */
  pending?: string;
}

/** The text a readiness row shows to the user. */
export function readinessItemText(item: Pick<RunReadinessItem, "label" | "displayLabel">): string {
  return item.displayLabel ?? item.label;
}

/** Rows that keep Run disabled: not done, and not deferred into the run itself. */
export function blockingReadinessItems<T extends RunReadinessItem>(items: readonly T[]): T[] {
  return items.filter((item) => !item.done && !item.pending);
}

/** Message shown on the mesh row when the study is marked meshed but no mesh exists. */
export const MESH_BUILT_ON_RUN_NOTE = "No mesh yet: one is built when you run, or generate it now on the Mesh step to check it first.";

/**
 * Whether a real mesh exists for the study's current inputs. A study can carry
 * `status: "complete"` with only a preset estimate or a seeded sample summary
 * (no counts from a mesher), which used to tick "Mesh generated" while the Mesh
 * step showed "--" for nodes and elements. Only a mesher-produced summary
 * (structured Core grid or in-browser Gmsh) or a stored volume mesh counts.
 */
export function studyHasGeneratedMesh(study: Pick<Study, "meshSettings">): boolean {
  if (study.meshSettings.status !== "complete") return false;
  const summary = study.meshSettings.summary;
  if (summary?.source === "core_solver" || summary?.source === "wasm_gmsh") return true;
  const artifacts = summary?.artifacts as Record<string, unknown> | undefined;
  return Boolean(artifacts?.actualCoreModel);
}

const THERMAL_LABELS: Record<string, string> = {
  "Support added": "Fixed temperature added",
  "Load added": "Heat load added"
};

/**
 * Readiness groups, most specific prefix first — the first group that claims a
 * diagnostic owns it. Order matters: `validation-dynamic-support` is a support
 * problem, not a solver-settings problem, so the support group must be tried
 * before the settings group.
 */
/**
 * Ownership contract for the three validation layers:
 * - @openfea/schema (zod Study/Project shape): rejects malformed payloads at
 *   parse time; never emits readiness diagnostics.
 * - @openfea/study-core validateStudy (domain readiness): every diagnostic id
 *   below must be claimed by exactly one group here, or surface as a "Study
 *   valid" blocker. Adding a validator rule without a group fails the
 *   cross-layer test in runReadiness.test.ts — update the groups, not the gate.
 * - @openfea/core validateModelJson (Core-model validity) + adapter
 *   openFeaCoreEligibility/buildOpenFeaCoreModelForStudy (routing): their
 *   throws surface at run time via the run-error path, not readiness. Every
 *   builder throw for user-fixable input must have a corresponding
 *   study-core/eligibility diagnostic; the adapter test pins the mapping.
 */
const READINESS_GROUPS: ReadonlyArray<{ label: string; prefixes: readonly string[] }> = [
  { label: "Material assigned", prefixes: ["validation-material"] },
  {
    label: "Support added",
    prefixes: ["validation-support", "validation-modal-support", "validation-dynamic-support", "validation-thermal-support"]
  },
  { label: "Load added", prefixes: ["validation-load", "validation-thermal-load", "validation-combination", "validation-load-case"] },
  { label: "Mesh generated", prefixes: ["validation-mesh"] },
  { label: "Run settings valid", prefixes: ["validation-dynamic", "validation-modal-mode-count"] }
];

const ALWAYS_SHOWN = new Set(["Material assigned", "Support added", "Load added", "Mesh generated"]);

/**
 * The Run gate, derived from the domain validator rather than from a parallel
 * set of presence checks.
 *
 * The presence checks this replaced ("a load exists") passed a load of -1 N
 * straight through to a solver that then rejected it. `validateStudy` already
 * knew the rule; nothing called it. Deriving readiness from its diagnostics is
 * what keeps the two from drifting apart again.
 */
export function readinessForStudy(study: Study | null, customMaterials: readonly CustomMaterial[] = [], context: StudyValidationContext = {}): RunReadinessItem[] {
  if (!study) return READINESS_GROUPS.filter((group) => ALWAYS_SHOWN.has(group.label)).map((group) => ({ label: group.label, done: false, blockers: [] }));

  const diagnostics = validateStudy(study, customMaterials, context);
  const claimed = new Map<string, string[]>();
  const unclaimed: string[] = [];
  for (const diagnostic of diagnostics) {
    const group = READINESS_GROUPS.find((candidate) => candidate.prefixes.some((prefix) => matchesPrefix(diagnostic, prefix)));
    if (!group) {
      unclaimed.push(diagnostic.message);
      continue;
    }
    claimed.set(group.label, [...(claimed.get(group.label) ?? []), diagnostic.message]);
  }

  const items = READINESS_GROUPS.flatMap((group) => {
    // Modal analysis runs on stiffness and mass alone; a load row would always
    // read as done and tell the user nothing.
    if (group.label === "Load added" && study.type === "modal_analysis") return [];
    const blockers = claimed.get(group.label) ?? [];
    // Settings rows only earn a place in the checklist once they have something
    // to say; the four core steps are always part of the workflow.
    if (!ALWAYS_SHOWN.has(group.label) && !blockers.length) return [];
    const displayLabel = study.type === "steady_state_thermal" ? THERMAL_LABELS[group.label] : undefined;
    const item: RunReadinessItem = { label: group.label, ...(displayLabel ? { displayLabel } : {}), done: blockers.length === 0, blockers };
    // Marked meshed, but nothing a mesher produced: do not tick it, and do not
    // block the run either, which builds the mesh it needs on demand.
    if (group.label === "Mesh generated" && item.done && !studyHasGeneratedMesh(study)) {
      return [{ ...item, done: false, pending: MESH_BUILT_ON_RUN_NOTE }];
    }
    return [item];
  });

  // A diagnostic no group claims must still block the run — silently dropping
  // it would let a new validator rule pass the gate it was written to close.
  return unclaimed.length ? [...items, { label: "Study valid", done: false, blockers: unclaimed }] : items;
}

/**
 * The workflow step that resolves an unmet readiness row, with its rail label, so
 * the Run panel can offer "Go to <step>" beside each blocker. Rows the Run step
 * resolves itself (solver settings, unclaimed study diagnostics) return null.
 * Mirrors the stepper's own row-to-step map in StepNav.
 */
export function readinessItemStep(label: string): { step: "material" | "supports" | "loads" | "mesh"; stepLabel: string } | null {
  if (label === "Material assigned") return { step: "material", stepLabel: "Material" };
  if (label === "Support added") return { step: "supports", stepLabel: "Supports" };
  if (label === "Load added") return { step: "loads", stepLabel: "Loads" };
  if (label === "Mesh generated") return { step: "mesh", stepLabel: "Mesh" };
  return null;
}

function matchesPrefix(diagnostic: Diagnostic, prefix: string): boolean {
  return diagnostic.id === prefix || diagnostic.id.startsWith(`${prefix}-`);
}
