/* Local mesh sizing per B-rep face (plan 036 R2.2), shown in the Mesh panel.
   Sizes are stored in STEP model millimetres and shown in project units. */
import { useEffect, useState } from "react";

import { AlertTriangle, Plus, X } from "lucide-react";

import type { DisplayModel, MeshLocalSize, MeshQuality, Study } from "@openfea/schema";
import { BROWSER_SOLVE_LIMITS } from "@openfea/solve-pipeline/limits";

import { meshTargetSizeMmForPreset } from "../../lib/meshEstimates";
import {
  MIN_LOCAL_MESH_SIZE_MM,
  isLocalSizableFace,
  isValidLocalMeshSizeMm,
  planMeshLocalSizing,
  studyRequestedElementOrder,
  upsertMeshLocalSizes
} from "../../meshLocalSizing";
import type { StepFaceRegistry } from "../../stepFaces";
import { formatLength, lengthForUnits, type UnitSystem } from "../../unitDisplay";

import { Callout, Collapsible } from "./PanelChrome";
import type { RightPanelProps } from "./RightPanelProps";

/**
 * Validation scope shown with the controls. Plan 036 kept local sizing
 * development-grade until the plate-with-hole Kt gate, the mm vs m test and
 * the in-browser mesh proof passed (docs/validation/README.md); the note
 * now states what was verified and that the element sizes are gmsh targets.
 */
export const LOCAL_SIZING_MATURITY_NOTE = "Verified on the plate-with-hole Kt benchmark and the in-browser mesh proof. Sizes are mesher targets, not exact element sizes.";

type Props = {
  study: Study;
  displayModel: DisplayModel;
  selectedFace: RightPanelProps["selectedFace"];
  unitSystem: UnitSystem;
  preset: MeshQuality;
  disabled: boolean;
  onChange?: (rules: MeshLocalSize[]) => void;
};

/** Display unit for local sizes: mm for metric projects, in for US projects. */
function displayUnit(unitSystem: UnitSystem): "mm" | "in" {
  return lengthForUnits(1, "mm", unitSystem).units === "in" ? "in" : "mm";
}

function toDisplay(valueMm: number, unitSystem: UnitSystem): number {
  return lengthForUnits(valueMm, "mm", unitSystem).value;
}

/** Inverse of toDisplay: a typed project-unit length back to stored mm. */
export function localSizeInputToMm(value: number, unitSystem: UnitSystem): number {
  return displayUnit(unitSystem) === "in" ? lengthForUnits(value, "in", "SI").value : value;
}

function roundForInput(value: number): string {
  return String(Number(value.toPrecision(4)));
}

export function MeshLocalSizingSection({ study, displayModel, selectedFace, unitSystem, preset, disabled, onChange }: Props) {
  const rules = study.meshSettings.localSizing ?? [];
  const unit = displayUnit(unitSystem);
  const contentBase64 = displayModel.nativeCad?.format === "step" ? displayModel.nativeCad.contentBase64 : undefined;
  const [registry, setRegistry] = useState<StepFaceRegistry | null>(null);
  const globalSizeMm = meshTargetSizeMmForPreset(preset);
  const [draft, setDraft] = useState(() => roundForInput(toDisplay(Math.max(MIN_LOCAL_MESH_SIZE_MM, globalSizeMm / 4), unitSystem)));

  useEffect(() => {
    if (!contentBase64) {
      setRegistry(null);
      return;
    }
    let cancelled = false;
    // The registry module (occt-import-js) stays out of the main bundle.
    void import("../../stepFaces")
      .then((module) => module.peekStepFaceRegistryForBase64(contentBase64) ?? module.stepFaceRegistryFromBase64(contentBase64))
      .then((loaded) => {
        if (!cancelled) setRegistry(loaded);
      })
      .catch(() => {
        if (!cancelled) setRegistry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contentBase64]);

  if (!contentBase64) {
    return rules.length ? <p className="panel-copy">Local mesh sizes apply to STEP models only; they are ignored for this geometry.</p> : null;
  }

  const draftMm = localSizeInputToMm(Number(draft), unitSystem);
  const draftValid = draft.trim() !== "" && isValidLocalMeshSizeMm(draftMm);
  const sizableFace = isLocalSizableFace(selectedFace) ? selectedFace : null;
  const existingForFace = sizableFace ? rules.find((rule) => rule.faceId === sizableFace.id) : undefined;
  const plan = registry
    ? planMeshLocalSizing({
        rules,
        registry,
        globalSizeMm,
        elementOrder: studyRequestedElementOrder(study.solverSettings as Record<string, unknown> | undefined),
        maxDofs: BROWSER_SOLVE_LIMITS.maxDofs
      })
    : null;
  const unresolvedIds = new Set(plan?.unresolved.map((entry) => entry.rule.id) ?? []);
  const minimumLabel = formatLength(MIN_LOCAL_MESH_SIZE_MM, "mm", unitSystem);

  function addToSelectedFace() {
    if (!sizableFace || !draftValid || !onChange) return;
    onChange(upsertMeshLocalSizes(rules, [sizableFace], draftMm, registry));
  }

  return (
    <Collapsible title="Local sizing" subtitle={rules.length ? `${rules.length} ${rules.length === 1 ? "face" : "faces"}` : "Per face"} defaultOpen={rules.length > 0}>
      <section className="local-sizing-card" aria-label="Local mesh sizing">
        <p className="panel-copy">Use a smaller element size on chosen faces, such as a hole wall, and keep the preset size elsewhere. The size grows back to the preset size away from the face.</p>
        <p className="result-tier-chip approximation">{LOCAL_SIZING_MATURITY_NOTE}</p>
        {rules.length > 0 && (
          <ul className="local-sizing-list" aria-label="Faces with a local size">
            {rules.map((rule) => (
              <LocalSizeRow
                key={rule.id}
                rule={rule}
                unitSystem={unitSystem}
                unit={unit}
                disabled={disabled || !onChange}
                unresolved={unresolvedIds.has(rule.id)}
                notFiner={rule.sizeMm >= globalSizeMm}
                onCommit={(sizeMm) => onChange?.(rules.map((candidate) => candidate.id === rule.id ? { ...candidate, sizeMm } : candidate))}
                onRemove={() => onChange?.(rules.filter((candidate) => candidate.id !== rule.id))}
              />
            ))}
          </ul>
        )}
        <div className="local-sizing-add">
          <label className="field">
            <span>Local size ({unit})</span>
            <input
              type="number"
              inputMode="decimal"
              min={roundForInput(toDisplay(MIN_LOCAL_MESH_SIZE_MM, unitSystem))}
              step="any"
              value={draft}
              disabled={disabled}
              aria-invalid={!draftValid}
              aria-describedby="local-sizing-add-hint"
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addToSelectedFace();
                }
              }}
            />
          </label>
          <button className="secondary wide" type="button" disabled={disabled || !onChange || !sizableFace || !draftValid} onClick={addToSelectedFace}>
            <Plus size={16} />{existingForFace ? "Update selected face" : "Add to selected face"}
          </button>
          <p className="panel-copy" id="local-sizing-add-hint">
            {sizableFace
              ? `Selected: ${sizableFace.label}. Minimum ${minimumLabel}.`
              : "Select a face in the viewer (or with the keyboard face list) to add a local size."}
          </p>
        </div>
        {plan && (
          <>
            <p className="panel-copy" aria-live="polite">
              Estimated before meshing (approximation): about {plan.estimate.elements.toLocaleString()} elements and {plan.preflight.estimatedDofs.toLocaleString()} DOF, against the {plan.preflight.maxDofs.toLocaleString()} DOF browser limit.
            </p>
            {plan.preflight.message && (
              <p className="panel-warning" role="alert"><AlertTriangle size={16} />{plan.preflight.message}</p>
            )}
          </>
        )}
        <Callout>Local sizes are stored per CAD face. Faces that change shape in a new model version are reported and left at the preset size.</Callout>
      </section>
    </Collapsible>
  );
}

function LocalSizeRow({ rule, unitSystem, unit, disabled, unresolved, notFiner, onCommit, onRemove }: {
  rule: MeshLocalSize;
  unitSystem: UnitSystem;
  unit: "mm" | "in";
  disabled: boolean;
  unresolved: boolean;
  notFiner: boolean;
  onCommit: (sizeMm: number) => void;
  onRemove: () => void;
}) {
  const stored = roundForInput(toDisplay(rule.sizeMm, unitSystem));
  const [value, setValue] = useState(stored);
  useEffect(() => setValue(stored), [stored]);
  const label = rule.label ?? rule.faceId;
  const parsedMm = localSizeInputToMm(Number(value), unitSystem);
  const valid = value.trim() !== "" && isValidLocalMeshSizeMm(parsedMm);

  function commit() {
    if (!valid) {
      setValue(stored);
      return;
    }
    if (value !== stored) onCommit(parsedMm);
  }

  return (
    <li className="load-case-row local-sizing-row">
      <span>
        <strong>{label}</strong>
        {unresolved && <small className="panel-warning"><AlertTriangle size={14} aria-hidden="true" />Face changed or missing; pick it again.</small>}
        {!unresolved && notFiner && <small>Not finer than the preset size; no refinement.</small>}
      </span>
      <label className="local-sizing-value">
        <span className="visually-hidden">Local size for {label} ({unit})</span>
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={value}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(event) => setValue(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              setValue(stored);
            }
          }}
        />
        <span aria-hidden="true">{unit}</span>
      </label>
      <button className="remove-glyph" type="button" disabled={disabled} aria-label={`Remove local size from ${label}`} onClick={onRemove}><X size={15} /></button>
    </li>
  );
}
