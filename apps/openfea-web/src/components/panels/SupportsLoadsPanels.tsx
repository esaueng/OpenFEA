/* Step panel extracted from RightPanel.tsx: file move only, no behavior change.
   Shared contracts live in ./RightPanelProps; panels never import each other. */
import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";

import { Gauge, Plus, ScanLine, Weight, X } from "lucide-react";

import { massKgForPayloadMaterial, payloadMaterialForId, payloadMaterials, type PayloadMaterialCategory } from "@openfea/materials";

import { fixedSupportComponents, SUPPORT_COMPONENTS, type Constraint, type DisplayFace, type DisplayModel, type Load, type LoadCase, type LoadCombination, type Study, type SupportComponent } from "@openfea/schema";
import { selectionRefsFor } from "@openfea/study-core";

import { createViewerLoadMarkers, directionLabelForLoad, directionLabelForVector, directionVectorForLabel, equivalentForceForLoad, LOAD_DIRECTION_LABELS, loadMagnitudeError, loadMarkerOrdinalLabel, payloadObjectForLoad, unitsForLoadType, type LoadApplicationPoint, type LoadDirectionLabel, type LoadType, type PayloadLoadMetadata, type PayloadMassMode } from "../../loadPreview";
import { type PayloadObjectSelection } from "../../workspaceViewTypes";

import { supportDisplayLabel } from "../../supportLabels";
import { displayFacesForEntry, fixedSupportParameters, isPartialFixedSupport, structuralSupportDescription, SUPPORT_COMPONENT_DEVELOPMENT_NOTE, symmetryCheckForFaces, SYMMETRY_MODAL_NOTE, SYMMETRY_SUPPORT_TOLERANCE_NOTE } from "../../supportDescriptions";

import { formatDensity, formatDisplayNumber, formatMass, formatVolume, lengthForUnits, loadValueForUnits, temperatureForUnits, type UnitSystem } from "../../unitDisplay";
import { stepFaceLabelForUnits } from "../../stepFaceLabels";
import { handleRadioGroupKeyDown, radioTabIndex } from "../radioGroupKeyboard";

import type { RightPanelProps } from "./RightPanelProps";
import { WorkingSelectionBar } from "./NamedSelectionsDialog";
import { isManagedNamedSelection, selectionFaceIds } from "../../namedSelections";
import { noopDraftPayloadPreviewChange } from "./RightPanelProps";
import { Panel, sameLoadDirection, structuralLoadCasesForPanel } from "./PanelChrome";
import { Callout, Collapsible, EmptyEditableList, HelpLabel, Info, PlacementReadout, SectionTitle, SupportIcon, defaultValueForLoadType, directionOptionLabel, directionPhrase, formatEquivalentForce, formatInputValue, formatNumber, loadTypeLabel, selectionForFace } from "./PanelChrome";
export function SupportsPanel({ project, displayModel, selectedFace, study, draftSupportTemperature, onDraftSupportTemperatureChange, onAddSupport, onUpdateSupport, onRemoveSupport, additionalSelectionRefs, onToggleAdditionalSelectionRef, namedSelectionManager }: RightPanelProps) {
  const unitSystem = project.unitSystem;
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const thermal = study.type === "steady_state_thermal";
  const modal = study.type === "modal_analysis";
  // Multi-face BCs (Decision 2): the viewer pick seeds the first face;
  // additional faces toggle on from the selection list below. The checklist
  // clears once a support is added, so the next Add starts from one face.
  const [extraSelectionRefs, toggleExtraRef] = useAdditionalFaces(study.constraints.length, additionalSelectionRefs, onToggleAdditionalSelectionRef);
  // The draft temperature lives in the workspace so a viewer pick uses the
  // typed value too (2026-09 review D12); fall back to local state for callers
  // that do not supply it. Stored and drafted in °C (the solver's value);
  // entered and shown in the project's units.
  const [localTemperature, setLocalTemperature] = useState(20);
  const temperature = draftSupportTemperature ?? localTemperature;
  const setTemperature = onDraftSupportTemperatureChange ?? setLocalTemperature;
  // Prescribed displacement: imposed motion along one axis, stored in mm (the
  // study format; the adapter converts to solver units) and entered in the
  // project's length unit. Zero behaves as a fixed component; the solver treats
  // it as a Dirichlet value.
  const [displacementKind, setDisplacementKind] = useState<StructuralSupportKind>("fixed");
  const [displacementValueMm, setDisplacementValueMm] = useState(0);
  const [displacementComponent, setDisplacementComponent] = useState<"x" | "y" | "z">("z");
  // Per-component fixed supports (plan 036 R1.4): all three until the user chooses.
  const [fixedComponents, setFixedComponents] = useState<SupportComponent[]>([...SUPPORT_COMPONENTS]);
  const prescribedDisplacement = displacementKind === "prescribed_displacement" && !thermal && !modal;
  const symmetrySupport = displacementKind === "symmetry" && !thermal;
  const fixedSupport = !thermal && !prescribedDisplacement && !symmetrySupport;
  const displacementValid = Number.isFinite(displacementValueMm);
  const addLabel = thermal ? "Add prescribed temperature" : prescribedDisplacement ? "Add prescribed displacement" : symmetrySupport ? "Add symmetry support" : study.constraints.length ? "Add another fixed support" : "Add fixed support";
  // The panel button used to stack a second support on a face that already
  // had one; the viewer-click path already refused that (2026-09 review D2).
  const existingOnSelection = selectedFromViewport ? study.constraints.find((support) => support.selectionRef === selectedFromViewport.id) : undefined;
  const duplicateSupportError = existingOnSelection
    ? `${thermal ? "A temperature boundary" : "A support"} already exists on ${selectedFromViewport?.name ?? "this face"}. Edit or remove it below.`
    : null;
  const faceOptions = additionalFaceOptions(study);
  // A face checked here and then picked in the viewer is the primary face, not an extra.
  const extraRefsForAdd = extraSelectionRefs.filter((ref) => ref !== selectedFromViewport?.id);
  const appliedRefs = [selectedFromViewport?.id, ...extraRefsForAdd].filter((ref): ref is string => Boolean(ref));
  // A symmetry face is pre-checked on the display normal; the solve repeats
  // the check on the solver mesh, which is authoritative.
  const symmetryCheck = symmetrySupport && selectedFace
    ? symmetryCheckForFaces([selectedFace, ...displayFacesForEntry(study, displayModel, { selectionRef: "", selectionRefs: extraRefsForAdd })])
    : undefined;
  const symmetryError = symmetryCheck && !symmetryCheck.ok ? symmetryCheck.message : null;
  const componentsError = fixedSupport && fixedComponents.length === 0;
  const addDisabled = !selectedFromViewport || Boolean(duplicateSupportError) || (thermal && !Number.isFinite(temperature)) || (prescribedDisplacement && !displacementValid) || Boolean(symmetryError) || componentsError;
  const addOptions = thermal
    ? { type: "prescribed_temperature" as const, value: temperature }
    : prescribedDisplacement
      ? { type: "prescribed_displacement" as const, value: displacementValueMm, component: displacementComponent }
      : symmetrySupport
        ? { type: "symmetry" as const }
        : { type: "fixed" as const, components: fixedComponents };
  return (
    <Panel title={thermal ? "Temperature boundaries" : "Supports"} question={thermal ? "Where is the temperature fixed?" : "Where is it held still?"} step="supports" helper={thermal ? "Select a face and prescribe its steady boundary temperature." : "Choose where the part is held fixed. Select a face, or click inside a cylindrical hole to constrain its wall. You can add more than one support."} study={study}>
      <PlacementReadout selectedRef={selectedFromViewport} label={selectedFromViewport ? selectionDisplayName(study, displayModel, selectedFromViewport.id, unitSystem) : undefined} fallbackLabel={selectedFace ? stepFaceLabelForUnits(selectedFace.label, selectedFace.area, unitSystem) : undefined} helpId="supportPlacement" />
      {thermal && <TemperatureField valueCelsius={temperature} unitSystem={unitSystem} onChange={setTemperature} />}
      {!thermal && (
        <label className="field">Support type
          <select value={modal && displacementKind === "prescribed_displacement" ? "fixed" : displacementKind} onChange={(event) => setDisplacementKind(event.currentTarget.value as StructuralSupportKind)}>
            <option value="fixed">Fixed support</option>
            <option value="symmetry">Symmetry / roller</option>
            {!modal && <option value="prescribed_displacement">Prescribed displacement</option>}
          </select>
        </label>
      )}
      {fixedSupport && <FixedComponentsField components={fixedComponents} onChange={setFixedComponents} />}
      {symmetrySupport && (
        <p className="field-note">
          {symmetryCheck?.ok ? `Holds ${symmetryCheck.component.toUpperCase()}, the face normal. ` : ""}{SYMMETRY_SUPPORT_TOLERANCE_NOTE}{modal ? ` ${SYMMETRY_MODAL_NOTE}` : ""}
        </p>
      )}
      {symmetryError && <p className="field-error" role="alert">{symmetryError}</p>}
      {prescribedDisplacement && (
        <>
          <DisplacementField valueMm={displacementValueMm} unitSystem={unitSystem} onChange={setDisplacementValueMm} />
          <label className="field">Component
            <select value={displacementComponent} onChange={(event) => setDisplacementComponent(event.currentTarget.value as "x" | "y" | "z")}>
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
          </label>
        </>
      )}
      {duplicateSupportError && <p className="field-error" role="alert">{duplicateSupportError}</p>}
      {!thermal && !modal && faceOptions.length > 1 && (
        <AdditionalFacesPicker
          options={faceOptions.filter((selection) => selection.id !== selectedFromViewport?.id).map((selection) => ({ id: selection.id, name: selectionDisplayName(study, displayModel, selection.id, unitSystem) }))}
          selectedRefs={extraSelectionRefs}
          onToggle={toggleExtraRef}
        />
      )}
      {namedSelectionManager && !modal ? <WorkingSelectionBar study={study} manager={namedSelectionManager} /> : null}
      <button className="outline-action wide" disabled={addDisabled} title={duplicateSupportError ?? symmetryError ?? undefined} onClick={() => selectedFromViewport && !addDisabled && onAddSupport(selectedFromViewport.id, addOptions, extraRefsForAdd.length ? { selectionRefs: extraRefsForAdd } : undefined)}><Plus size={18} />{addLabel}{appliedRefs.length > 1 ? ` (${appliedRefs.length} faces)` : ""}</button>
      <SupportEditorList study={study} displayModel={displayModel} unitSystem={unitSystem} retargetFace={selectedFace} onUpdateSupport={onUpdateSupport} onRemoveSupport={onRemoveSupport} />
      <Callout>{thermal ? "At least one prescribed temperature is required to make the conduction system unique." : "A fixed support holds the selected face in the chosen directions (all three by default). A symmetry/roller support holds only the face-normal direction."}</Callout>
      {!thermal && (symmetrySupport || (fixedSupport && fixedComponents.length < SUPPORT_COMPONENTS.length) || study.constraints.some((support) => support.type === "symmetry" || isPartialFixedSupport(support))) && (
        <p className="field-note">{SUPPORT_COMPONENT_DEVELOPMENT_NOTE}</p>
      )}
    </Panel>
  );
}

type StructuralSupportKind = "fixed" | "symmetry" | "prescribed_displacement";

/**
 * The directions a fixed support holds (plan 036 R1.4). "All" keeps the
 * classic clamp; "Chosen" holds a subset of the global X, Y and Z components
 * and leaves the others free, e.g. an antisymmetry plane or a slider.
 */
export function FixedComponentsField({ components, onChange }: { components: readonly SupportComponent[]; onChange: (components: SupportComponent[]) => void }) {
  const [chosen, setChosen] = useState(components.length < SUPPORT_COMPONENTS.length);
  const mode = chosen ? "chosen" : "all";
  const options = [
    { id: "all", label: "All (X, Y, Z)", title: "Hold every displacement component of the face" },
    { id: "chosen", label: "Chosen components", title: "Hold only the global components you tick; the others stay free" }
  ] as const;
  return (
    <div className="field fixed-components-field">
      <span id="fixed-components-label">Held directions</span>
      <div className="segmented" role="radiogroup" aria-labelledby="fixed-components-label" onKeyDown={handleRadioGroupKeyDown}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={mode === option.id}
            tabIndex={radioTabIndex(mode === option.id)}
            className={mode === option.id ? "active" : ""}
            title={option.title}
            onClick={() => {
              if (option.id === "all") {
                setChosen(false);
                onChange([...SUPPORT_COMPONENTS]);
              } else {
                setChosen(true);
              }
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {chosen && (
        <fieldset className="component-checkboxes">
          <legend>Components held</legend>
          {SUPPORT_COMPONENTS.map((component) => (
            <label className="toggle" key={component}>
              <input
                type="checkbox"
                checked={components.includes(component)}
                onChange={() => onChange(components.includes(component)
                  ? components.filter((candidate) => candidate !== component)
                  : SUPPORT_COMPONENTS.filter((candidate) => candidate === component || components.includes(candidate)))}
              />
              <span>{component.toUpperCase()}</span>
            </label>
          ))}
        </fieldset>
      )}
      {chosen && components.length === 0 && <p className="field-error" role="alert">Choose at least one component to hold.</p>}
    </div>
  );
}

/**
 * Extra faces for a multi-face support or load. A bounded, scrolling list so a
 * model with many faces cannot push the Add button off the panel.
 */
function AdditionalFacesPicker({ options, selectedRefs, onToggle }: { options: ReadonlyArray<{ id: string; name: string }>; selectedRefs: readonly string[]; onToggle: (ref: string) => void }) {
  const selectedCount = options.filter((option) => selectedRefs.includes(option.id)).length;
  return (
    <fieldset className="field face-picker">
      <legend>
        Additional faces
        <span className="face-picker-meta">{selectedCount ? `${selectedCount} selected` : "Optional"}</span>
      </legend>
      <div className="face-picker-list">
        {options.map((selection) => (
          <label className="face-picker-row" key={selection.id}>
            <input type="checkbox" checked={selectedRefs.includes(selection.id)} onChange={() => onToggle(selection.id)} />
            <span>{selection.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type AdditionalFacesState = { refs: string[]; entryCount: number };
type AdditionalFacesAction = { type: "toggle"; ref: string } | { type: "entries"; count: number };

/**
 * The "Additional faces" checklist. It clears when the panel's list of supports
 * or loads grows, i.e. after an Add succeeded (from the panel or a viewer
 * click), so the next Add does not silently reuse the previous extra faces.
 * Removing an entry keeps the draft.
 */
export function additionalFacesReducer(state: AdditionalFacesState, action: AdditionalFacesAction): AdditionalFacesState {
  if (action.type === "toggle") {
    return {
      ...state,
      refs: state.refs.includes(action.ref) ? state.refs.filter((candidate) => candidate !== action.ref) : [...state.refs, action.ref]
    };
  }
  if (action.count === state.entryCount) return state;
  return { refs: action.count > state.entryCount ? [] : state.refs, entryCount: action.count };
}

/**
 * The checklist state. When the workspace supplies `controlledRefs` and
 * `onToggle` (plan 036 R1.2), viewer Ctrl/Cmd-click and the checklist share
 * one list owned by the workspace; otherwise the panel keeps its own.
 */
function useAdditionalFaces(entryCount: number, controlledRefs?: readonly string[], onToggle?: (ref: string) => void): [readonly string[], (ref: string) => void] {
  const [state, dispatch] = useReducer(additionalFacesReducer, entryCount, (count): AdditionalFacesState => ({ refs: [], entryCount: count }));
  useEffect(() => dispatch({ type: "entries", count: entryCount }), [entryCount]);
  if (controlledRefs && onToggle) return [controlledRefs, onToggle];
  return [state.refs, (ref: string) => dispatch({ type: "toggle", ref })];
}

/**
 * The faces offered as "Additional faces": the automatic per-face selections.
 * Managed named selections are reused whole through the manager, not ticked
 * here face by face.
 */
function additionalFaceOptions(study: Study) {
  return study.namedSelections.filter((selection) => selection.entityType === "face" && !isManagedNamedSelection(selection));
}

/** Boundary temperature: stored in °C, entered in the project's temperature unit. */
export function TemperatureField({ valueCelsius, unitSystem, onChange }: { valueCelsius: number; unitSystem: UnitSystem; onChange: (valueCelsius: number) => void }) {
  const display = temperatureForUnits(valueCelsius, "°C", unitSystem);
  return (
    <label className="field">Temperature<span className="input-with-unit"><input type="number" value={formatInputValue(display.value)} onChange={(event) => onChange(temperatureForUnits(Number(event.currentTarget.value), display.units, "SI").value)} /><span>{display.units}</span></span></label>
  );
}

/** Prescribed displacement: stored in mm, entered in the project's length unit. */
export function DisplacementField({ valueMm, unitSystem, onChange }: { valueMm: number; unitSystem: UnitSystem; onChange: (valueMm: number) => void }) {
  const display = lengthForUnits(valueMm, "mm", unitSystem);
  return (
    <label className="field">Displacement<span className="input-with-unit"><input type="number" value={formatInputValue(display.value)} onChange={(event) => onChange(lengthForUnits(Number(event.currentTarget.value), display.units, "SI").value)} /><span>{display.units}</span></span></label>
  );
}

/** One selection's display name: its face label, with a STEP area suffix in project units. */
function selectionDisplayName(study: Study, displayModel: DisplayModel, selectionRef: string, unitSystem: UnitSystem): string {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  if (!selection) return "selected face";
  if (isManagedNamedSelection(selection)) {
    const count = selectionFaceIds(study, selection.id).length;
    return `${selection.name} (${count} face${count === 1 ? "" : "s"})`;
  }
  const geometryRef = selection.geometryRefs[0];
  const label = geometryRef?.label ?? selection.name;
  const face = geometryRef?.entityType === "face" ? displayModel.faces.find((candidate) => candidate.id === geometryRef.entityId) : undefined;
  return stepFaceLabelForUnits(label, face?.area, unitSystem);
}

/**
 * Every face a support or load acts on, primary first. Same refs, order and
 * de-duplication the adapter (and the report's selectionLabels) use.
 */
function entryFaceNames(study: Study, displayModel: DisplayModel, entry: { selectionRef: string; selectionRefs?: string[] }, unitSystem: UnitSystem): string[] {
  const names = selectionRefsFor(entry).flatMap((ref) => {
    const selection = study.namedSelections.find((candidate) => candidate.id === ref);
    if (!selection || !isManagedNamedSelection(selection)) return [selectionDisplayName(study, displayModel, ref, unitSystem)];
    // A reused named selection acts on every face in it.
    return selection.geometryRefs.filter((geometryRef) => geometryRef.entityType === "face").map((geometryRef) => {
      const face = displayModel.faces.find((candidate) => candidate.id === geometryRef.entityId);
      return stepFaceLabelForUnits(geometryRef.label, face?.area, unitSystem);
    });
  });
  return names.length ? names : ["selected face"];
}

/** The managed named selection a support or load reuses, named in its row ("Bolt holes · …"). */
function entryNamedSelectionPrefix(study: Study, entry: { selectionRef: string; selectionRefs?: string[] }): string {
  const names = selectionRefsFor(entry)
    .map((ref) => study.namedSelections.find((candidate) => candidate.id === ref))
    .filter((selection) => isManagedNamedSelection(selection))
    .map((selection) => selection!.name);
  return names.length ? `${names.join(", ")} · ` : "";
}

function additionalFaceCountLabel(names: readonly string[]): string {
  const extra = names.length - 1;
  return extra > 0 ? ` +${extra} face${extra === 1 ? "" : "s"}` : "";
}

/**
 * How a multi-face load reaches the solver. The adapter unions the faces'
 * facets into one surface set; Core then applies a total force by facet area
 * over that combined set, and a pressure or traction at full value on each face.
 */
export function multiFaceLoadNote(type: LoadType, faceCount: number): string | null {
  if (faceCount < 2) return null;
  if (type === "force") return `The total force is shared across all ${faceCount} faces in proportion to their area, not applied in full to each face.`;
  if (type === "remote_force") return `The remote force and its moment are distributed over the combined area of all ${faceCount} faces.`;
  if (type === "pressure" || type === "surface_traction") return `The full ${type === "pressure" ? "pressure" : "traction"} acts on each of the ${faceCount} faces.`;
  return null;
}

/** The load this panel just added, and the draft that added it. */
export type JustAddedLoad = { loadId: string; draftKey: string } | null;

/**
 * Tracks the load an Add just created. A single new load id marks it; any
 * change of the draft (face, type, magnitude, direction) forgets it, so a draft
 * that later returns to an existing load is refused as a duplicate again.
 */
export function justAddedLoadAfterChange(previousIds: readonly string[], nextIds: readonly string[], draftKey: string, current: JustAddedLoad): JustAddedLoad {
  const added = nextIds.filter((id) => !previousIds.includes(id));
  if (nextIds.length > previousIds.length && added.length === 1) return { loadId: added[0]!, draftKey };
  if (current && (current.draftKey !== draftKey || !nextIds.includes(current.loadId))) return null;
  return current;
}

export function duplicateLoadFeedback(duplicateLoadId: string | undefined, justAdded: JustAddedLoad, draftKey: string): "duplicate" | "just_added" | null {
  if (!duplicateLoadId) return null;
  return justAdded?.loadId === duplicateLoadId && justAdded.draftKey === draftKey ? "just_added" : "duplicate";
}

const AXIS_DIRECTION_LABELS: readonly LoadDirectionLabel[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

function isLoadDirectionLabel(value: unknown): value is LoadDirectionLabel {
  return typeof value === "string" && (LOAD_DIRECTION_LABELS as readonly string[]).includes(value);
}

function sameDirection(left: readonly number[], right: readonly number[]): boolean {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  if (!(leftLength > 0) || !(rightLength > 0)) return false;
  return (left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!) / (leftLength * rightLength) > 0.999;
}

/**
 * The direction the user chose for a load: its stored directionMode when that
 * still matches the stored vector, else the label derived from the vector
 * (legacy loads carry no mode). Deriving alone named an Add made with
 * "Along axis -Z" as "into the face" whenever -Z was also the face's inward
 * normal, contradicting the form that created it.
 */
export function storedLoadDirectionLabel(load: Load, displayModel: DisplayModel, face?: DisplayFace): LoadDirectionLabel {
  const mode = load.parameters.directionMode;
  const vector = load.parameters.direction;
  const derived = directionLabelForLoad(load, displayModel, face);
  if (!isLoadDirectionLabel(mode)) return derived;
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every((component) => typeof component === "number")) return mode;
  if ((mode === "Normal" || mode === "Opposite normal") && !face) return mode;
  const expectedFace: DisplayFace = face ?? { id: "direction-check", label: "", color: "#fff", center: [0, 0, 0], normal: [0, 0, 1], stressValue: 0 };
  return sameDirection(directionVectorForLabel(mode, expectedFace, displayModel), vector as number[]) ? mode : derived;
}

/**
 * Row text for a load's direction, led by the chosen label. When the vector is
 * both a global axis and the face's normal (or its opposite) the other reading
 * follows in brackets, so "along global -Z" and "into the face" never disagree.
 */
export function loadDirectionDescription(load: Load, displayModel: DisplayModel, face?: DisplayFace): string {
  const primary = storedLoadDirectionLabel(load, displayModel, face);
  const faceRelative = face ? directionLabelForVector(load.parameters.direction, displayModel, face) : undefined;
  const axis = directionLabelForVector(load.parameters.direction, displayModel);
  const alternative = AXIS_DIRECTION_LABELS.includes(primary)
    ? faceRelative === "Normal" || faceRelative === "Opposite normal" ? faceRelative : undefined
    : AXIS_DIRECTION_LABELS.includes(axis) ? axis : undefined;
  return alternative && alternative !== primary ? `${directionPhrase(primary)} (${directionPhrase(alternative)})` : directionPhrase(primary);
}

/** The complete face list under a multi-face row; a single-face row shows nothing extra. */
function EntryFaceList({ names, note }: { names: readonly string[]; note?: string | null }) {
  if (names.length < 2) return null;
  return <small className="entry-face-list">Faces ({names.length}): {names.join(" + ")}{note ? ` — ${note}` : ""}</small>;
}

export function LoadsPanel({
  project,
  displayModel,
  selectedFace,
  study,
  draftLoadType,
  draftLoadValue,
  draftLoadDirection,
  selectedLoadPoint,
  selectedPayloadObject,
  onDraftLoadTypeChange,
  onDraftLoadValueChange,
  onDraftLoadDirectionChange,
  onDraftPayloadPreviewChange = noopDraftPayloadPreviewChange,
  onAddLoad,
  onUpdateLoad,
  onPreviewLoadEdit,
  onRemoveLoad,
  onLoadCasesChange,
  additionalSelectionRefs,
  onToggleAdditionalSelectionRef,
  namedSelectionManager
}: RightPanelProps) {
  const [editingLoadId, setEditingLoadId] = useState<string | null>(null);
  const thermal = study.type === "steady_state_thermal";
  const selectedFromViewport = selectedFace ? selectionForFace(study, selectedFace.id) : undefined;
  const bodySelection = study.namedSelections.find((selection) => selection.entityType === "body");
  const placementSelection = draftLoadType === "gravity" ? undefined : draftLoadType === "volume_force" || draftLoadType === "heat_generation" ? bodySelection : selectedFromViewport;
  const units = unitsForLoadType(draftLoadType);
  const valueLabel = draftLoadType === "gravity" ? "Payload mass" : draftLoadType === "heat_flux" ? "Inward heat flux" : draftLoadType === "heat_generation" ? "Volumetric heat generation" : "Magnitude";
  const addLabel = draftLoadType === "gravity" ? "Add payload mass" : thermal ? "Add thermal load" : "Add load";
  const [payloadMaterialId, setPayloadMaterialId] = useState("payload-steel");
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>("material");
  const [remotePoint, setRemotePoint] = useState<LoadApplicationPoint>(() => selectedLoadPoint ?? selectedFace?.center ?? [0, 0, 0]);
  const secondaryFaceOptions = useMemo(
    () => study.namedSelections.filter((selection) => selection.entityType === "face" && selection.id !== selectedFromViewport?.id),
    [selectedFromViewport?.id, study.namedSelections]
  );
  // Multi-face loads (Decision 2): extra faces share the same magnitude and
  // direction. The adapter unions their facets into one surface set, so a
  // total force is shared by area over the combined faces while a pressure or
  // traction acts in full on each (see multiFaceLoadNote). The checklist
  // clears once a load is added.
  const [extraLoadRefs, toggleExtraLoadRef] = useAdditionalFaces(study.loads.length, additionalSelectionRefs, onToggleAdditionalSelectionRef);
  const faceOptionsForLoad = additionalFaceOptions(study);
  const extraFacesApply = !thermal && draftLoadType !== "gravity" && draftLoadType !== "volume_force" && draftLoadType !== "heat_generation" && draftLoadType !== "bolt_preload";
  const extraLoadRefsForAdd = extraFacesApply ? extraLoadRefs.filter((ref) => ref !== placementSelection?.id) : [];
  const draftMultiFaceNote = multiFaceLoadNote(draftLoadType, extraLoadRefsForAdd.length + 1);
  const [secondarySelectionRef, setSecondarySelectionRef] = useState(secondaryFaceOptions[0]?.id ?? "");
  const payloadVolumeM3 = selectedPayloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const effectiveDraftValue = draftLoadType === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : draftLoadValue;
  const displayDraftLoad = loadValueForUnits(effectiveDraftValue, units, project.unitSystem);
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const canAddPayloadMass = payloadMassMode === "manual" ? draftLoadValue > 0 : calculatedPayloadMass > 0;
  const draftMagnitudeError = loadMagnitudeError(effectiveDraftValue, study.type);
  const hasDraftPlacement = draftLoadType === "gravity"
    ? Boolean(selectedPayloadObject) && canAddPayloadMass
    : draftLoadType === "volume_force" || draftLoadType === "heat_generation"
      ? Boolean(bodySelection)
      : draftLoadType === "bolt_preload"
        ? Boolean(selectedFace && secondarySelectionRef)
        : Boolean(selectedFace);
  // A second click on Add stacked an identical load on the same face and
  // silently doubled the applied force (2026-09 review D2). Refuse the exact
  // duplicate and point at the edit form instead.
  const duplicateLoad = placementSelection
    ? study.loads.find((load) => load.selectionRef === placementSelection.id && load.type === draftLoadType
        && (thermal || !selectedFace || sameLoadDirection(load.parameters.direction, directionVectorForLabel(draftLoadDirection, selectedFace, displayModel)))
        && Number(load.parameters.value) === effectiveDraftValue)
    : undefined;
  // Right after a successful Add the face is still selected and the draft
  // still matches, so the guard above would flag the load just created as a
  // duplicate. Say it was added instead; the guard (and the disabled Add) stay,
  // and the red error returns once the draft changes and comes back to it.
  const draftKey = [placementSelection?.id ?? "", draftLoadType, effectiveDraftValue, draftLoadDirection].join("|");
  // Updated during render (not in an effect) so the red error never flashes
  // for one frame between the Add and the bookkeeping.
  const loadIds = study.loads.map((load) => load.id);
  const [loadTracking, setLoadTracking] = useState<{ ids: string[]; draftKey: string; justAdded: JustAddedLoad }>(() => ({ ids: loadIds, draftKey, justAdded: null }));
  if (loadTracking.draftKey !== draftKey || loadTracking.ids.join("\n") !== loadIds.join("\n")) {
    setLoadTracking({ ids: loadIds, draftKey, justAdded: justAddedLoadAfterChange(loadTracking.ids, loadIds, draftKey, loadTracking.justAdded) });
  }
  const duplicateFeedback = duplicateLoadFeedback(duplicateLoad?.id, justAddedLoadAfterChange(loadTracking.ids, loadIds, draftKey, loadTracking.justAdded), draftKey);
  const duplicateLoadError = duplicateFeedback === "duplicate"
    ? `A ${loadTypeLabel(draftLoadType).toLowerCase()} of ${formatNumber(displayDraftLoad.value)} ${displayDraftLoad.units} is already applied to ${placementSelection?.name ?? "this face"}. Edit it to change the magnitude.`
    : null;
  const justAddedNotice = duplicateFeedback === "just_added"
    ? `Added to ${placementSelection ? selectionDisplayName(study, displayModel, placementSelection.id, project.unitSystem) : "this face"}. Pick another face, or change the magnitude or direction, to add another load.`
    : null;
  const draftAddError = draftMagnitudeError ?? duplicateLoadError;
  const canAddDraftLoad = hasDraftPlacement && !draftAddError && !justAddedNotice;
  const payloadMetadata: PayloadLoadMetadata = draftLoadType === "gravity"
    ? {
      payloadMaterialId,
      ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}),
      payloadMassMode
    }
    : {};
  function handleDraftValueChange(displayValue: number) {
    const baseValue = loadValueForUnits(displayValue, displayDraftLoad.units, "SI");
    onDraftLoadValueChange(baseValue.value);
  }
  useEffect(() => {
    if (thermal && draftLoadType !== "heat_flux" && draftLoadType !== "heat_generation") {
      onDraftLoadTypeChange("heat_flux");
      onDraftLoadValueChange(defaultValueForLoadType("heat_flux"));
    } else if (!thermal && (draftLoadType === "heat_flux" || draftLoadType === "heat_generation")) {
      onDraftLoadTypeChange("force");
      onDraftLoadValueChange(defaultValueForLoadType("force"));
    }
  }, [draftLoadType, onDraftLoadTypeChange, onDraftLoadValueChange, thermal]);
  useEffect(() => {
    onDraftPayloadPreviewChange(
      draftLoadType === "gravity"
        ? { value: effectiveDraftValue, metadata: payloadMetadata }
        : null
    );
  }, [draftLoadType, effectiveDraftValue, onDraftPayloadPreviewChange, payloadMassMode, payloadMaterialId, payloadVolumeM3]);
  useEffect(() => {
    if (draftLoadType === "remote_force" && selectedLoadPoint) setRemotePoint(selectedLoadPoint);
  }, [draftLoadType, selectedLoadPoint]);
  useEffect(() => {
    if (!secondaryFaceOptions.some((selection) => selection.id === secondarySelectionRef)) {
      setSecondarySelectionRef(secondaryFaceOptions[0]?.id ?? "");
    }
  }, [secondaryFaceOptions, secondarySelectionRef]);
  const structuralStudy = study.type === "static_stress" || study.type === "dynamic_structural" ? study : null;
  const loadCases = structuralStudy ? structuralLoadCasesForPanel(structuralStudy) : [];
  const loadCombinations = study.type === "static_stress" ? study.loadCombinations ?? [] : [];
  function assignLoadToCase(loadId: string, caseId: string) {
    if (!onLoadCasesChange) return;
    onLoadCasesChange(loadCases.map((loadCase) => ({
      ...loadCase,
      loadIds: loadCase.id === caseId
        ? [...loadCase.loadIds.filter((id) => id !== loadId), loadId]
        : loadCase.loadIds.filter((id) => id !== loadId)
    })), loadCombinations);
  }
  return (
    <Panel title={thermal ? "Thermal loads" : "Loads"} question={thermal ? "Where does heat go in or out?" : draftLoadType === "gravity" || draftLoadType === "volume_force" ? "What load does it carry?" : "Where does the force push?"} step="loads" helper={thermal ? (draftLoadType === "heat_generation" ? "Apply uniform heat generation throughout the selected body." : "Select a face and apply inward surface heat flux.") : draftLoadType === "gravity" ? "Choose the object carrying payload mass, then add its weight as a load." : draftLoadType === "volume_force" ? "Apply a force density to the selected structural body." : "Select a face on the model, then add the load."} study={study}>
      <div hidden={editingLoadId !== null}>
      <PlacementReadout
        helpId="loadPlacement"
        selectedRef={placementSelection}
        label={placementSelection ? selectionDisplayName(study, displayModel, placementSelection.id, project.unitSystem) : undefined}
        fallbackLabel={selectedPayloadObject?.label ?? (selectedFace ? stepFaceLabelForUnits(selectedFace.label, selectedFace.area, project.unitSystem) : undefined)}
        detail={selectedPayloadObject ? "object selected" : selectedLoadPoint ? "point picked" : undefined}
      />
      {draftLoadType === "gravity" ? (
        <PayloadMassControls
          unitSystem={project.unitSystem}
          payloadObject={selectedPayloadObject}
          payloadMaterialId={payloadMaterialId}
          payloadMassMode={payloadMassMode}
          manualMassKg={draftLoadValue}
          onPayloadMaterialChange={setPayloadMaterialId}
          onPayloadMassModeChange={setPayloadMassMode}
          onManualMassChange={handleDraftValueChange}
        />
      ) : (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">{valueLabel}</HelpLabel>
          <span className="input-with-unit">
            <input
              id="load-value"
              type="number"
              value={formatInputValue(displayDraftLoad.value)}
              onChange={(event) => handleDraftValueChange(Number(event.currentTarget.value))}
            />
            <span>{displayDraftLoad.units}</span>
          </span>
        </label>
      )}
      {draftLoadType === "gravity" && (
        <>
          <Info label="Selected density" value={formatDensity(selectedPayloadMaterial.density, "kg/m^3", project.unitSystem)} />
          <Info label="Calculated mass" value={formatMass(calculatedPayloadMass, "kg", project.unitSystem)} />
          <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: effectiveDraftValue } }), project.unitSystem)} equivalent weight.</Callout>
        </>
      )}
      {draftLoadType === "remote_force" ? (
        <fieldset className="field">
          <legend>Remote point coordinates ({REMOTE_POINT_UNIT_LABEL})</legend>
          <RemotePointInputs point={remotePoint} onChange={setRemotePoint} />
          <small>{remotePointFrameNote(project.unitSystem)} Distributed force and moment only; this is not a rigid MPC coupling.</small>
        </fieldset>
      ) : null}
      {draftLoadType === "bolt_preload" ? (
        <>
          <label className="field">Opposing face<select value={secondarySelectionRef} onChange={(event) => setSecondarySelectionRef(event.currentTarget.value)}>
            <option value="">Choose a different face</option>
            {secondaryFaceOptions.map((selection) => <option key={selection.id} value={selection.id}>{selection.name}</option>)}
          </select></label>
          <Callout>Bonded-linear approximation only: no contact, slip, or fastener stiffness.</Callout>
        </>
      ) : null}
      {!thermal && <DirectionChoice value={draftLoadDirection} onChange={onDraftLoadDirectionChange} />}
      {/* Load type, its explanation and extra faces are the advanced half of the form
          (plan 035, increment 2). The section opens itself whenever any of them is in use. */}
      <Collapsible
        title="More options"
        subtitle={loadTypeLabel(draftLoadType)}
        defaultOpen={draftLoadType !== (thermal ? "heat_flux" : "force") || extraLoadRefs.length > 0}
      >
      <label className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <select
          value={draftLoadType}
          onChange={(event) => {
            const type = event.currentTarget.value as LoadType;
            onDraftLoadTypeChange(type);
            if (type !== draftLoadType) onDraftLoadValueChange(defaultValueForLoadType(type));
          }}
        >
          {thermal ? <><option value="heat_flux">Surface heat flux</option><option value="heat_generation">Volumetric heat generation</option></> : <>
            <option value="force">Face force (total)</option>
            <option value="pressure">Pressure</option>
            <option value="surface_traction">Surface traction</option>
            <option value="volume_force">Volume force</option>
            <option value="remote_force">Remote force</option>
            {study.type === "static_stress" ? <option value="bolt_preload">Equivalent bolt preload</option> : null}
            <option value="gravity">Payload mass</option>
          </>}
        </select>
      </label>
      {draftLoadType === "force" ? <Callout>Face force is a total force distributed over the selected face. Its visual point does not affect the solve.</Callout> : null}
      {extraFacesApply && faceOptionsForLoad.length > 1 && (
        <AdditionalFacesPicker
          options={faceOptionsForLoad.filter((selection) => selection.id !== placementSelection?.id).map((selection) => ({ id: selection.id, name: selectionDisplayName(study, displayModel, selection.id, project.unitSystem) }))}
          selectedRefs={extraLoadRefs}
          onToggle={toggleExtraLoadRef}
        />
      )}
      </Collapsible>
      {draftMultiFaceNote && <Callout>{draftMultiFaceNote}</Callout>}
      {namedSelectionManager && extraFacesApply ? <WorkingSelectionBar study={study} manager={namedSelectionManager} /> : null}
      {hasDraftPlacement && draftAddError && <p className="field-error" role="alert">{draftAddError}</p>}
      {hasDraftPlacement && !draftAddError && justAddedNotice && <p className="panel-copy" role="status">{justAddedNotice}</p>}
      <button className="outline-action wide" disabled={!canAddDraftLoad} title={draftAddError ?? justAddedNotice ?? undefined} onClick={() => canAddDraftLoad && onAddLoad(
        draftLoadType,
        effectiveDraftValue,
        placementSelection?.id,
        draftLoadDirection,
        {
          ...payloadMetadata,
          ...(draftLoadType === "remote_force" ? { remotePoint } : {}),
          ...(draftLoadType === "bolt_preload" ? { secondarySelectionRef } : {}),
          ...(extraLoadRefsForAdd.length ? { selectionRefs: extraLoadRefsForAdd } : {})
        }
      )}>{/* selectionRefs travel in payloadMetadata and are split out by the workspace handler. */}<Plus size={18} />{addLabel}{extraLoadRefsForAdd.length ? ` (${extraLoadRefsForAdd.length + 1} faces)` : ""}</button>
      </div>
      {structuralStudy && (
        <Collapsible
          title="Load cases"
          subtitle={`${loadCases.length} case${loadCases.length === 1 ? "" : "s"}${loadCombinations.length ? ` · ${loadCombinations.length} combination${loadCombinations.length === 1 ? "" : "s"}` : ""}`}
          helpId="loadCases"
          defaultOpen={loadCases.length > 1 || loadCombinations.length > 0}
        >
          <LoadCasesEditor
            studyType={structuralStudy.type}
            loadCases={loadCases}
            loadCombinations={loadCombinations}
            onChange={(cases, combinations) => onLoadCasesChange?.(cases, combinations)}
          />
        </Collapsible>
      )}
      <LoadEditorList editingId={editingLoadId} onEditingIdChange={setEditingLoadId} study={study} displayModel={displayModel} unitSystem={project.unitSystem} loadCases={loadCases} retargetFace={selectedFace} onAssignLoadToCase={assignLoadToCase} onUpdateLoad={onUpdateLoad} onPreviewLoadEdit={onPreviewLoadEdit} onRemoveLoad={onRemoveLoad} />
    </Panel>
  );
}

/**
 * The remote point lives in the viewer's display frame (a viewport pick or a
 * face centre). The adapter maps it onto the solver mesh by the part's extents,
 * so it is not a physical length and is labelled by frame rather than mm/in.
 */
const REMOTE_POINT_UNIT_LABEL = "viewer frame";

function remotePointFrameNote(unitSystem: UnitSystem): string {
  return `Viewer-frame coordinates, as picked on the model; they are mapped onto the part for the solve and are not ${lengthForUnits(1, "mm", unitSystem).units} values.`;
}

function RemotePointInputs({ point, onChange }: { point: LoadApplicationPoint; onChange: (point: LoadApplicationPoint) => void }) {
  return (
    <div className="vector-inputs">
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>{axis}<input type="number" aria-label={`Remote point ${axis} (${REMOTE_POINT_UNIT_LABEL})`} value={point[index]} onChange={(event) => {
          const next = [...point] as LoadApplicationPoint;
          next[index] = Number(event.currentTarget.value);
          onChange(next);
        }} /></label>
      ))}
    </div>
  );
}

const AXIS_DIRECTIONS = LOAD_DIRECTION_LABELS.filter((label) => label !== "Normal" && label !== "Opposite normal");

/**
 * Direction as three plain choices. These are display labels only: the stored
 * directionMode values ("Opposite normal", "Normal", ±X/±Y/±Z) and the vectors
 * directionVectorForLabel builds from them are unchanged. "Normal" is the face's
 * outward normal, so "Opposite normal" is the one that pushes into the face.
 */
function DirectionChoice({ value, onChange }: { value: LoadDirectionLabel; onChange: (direction: LoadDirectionLabel) => void }) {
  const mode = value === "Opposite normal" ? "into" : value === "Normal" ? "out" : "axis";
  const choices = [
    { id: "into", label: "Into face", title: "Pushes into the selected face (opposite its outward normal)", direction: "Opposite normal" as const },
    { id: "out", label: "Out of face", title: "Pulls away from the selected face (along its outward normal)", direction: "Normal" as const },
    { id: "axis", label: "Along axis", title: "Acts along a global axis", direction: (AXIS_DIRECTIONS as readonly LoadDirectionLabel[]).includes(value) ? value : "-Z" as const }
  ];
  return (
    <div className="field direction-field">
      <HelpLabel helpId="loadDirection">Direction</HelpLabel>
      <div className="segmented direction-choice" role="radiogroup" aria-label="Direction" onKeyDown={handleRadioGroupKeyDown}>
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={mode === choice.id}
            tabIndex={radioTabIndex(mode === choice.id)}
            className={mode === choice.id ? "active" : ""}
            title={choice.title}
            onClick={() => { if (mode !== choice.id) onChange(choice.direction); }}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {mode === "axis" ? (
        <select aria-label="Axis direction" value={value} onChange={(event) => onChange(event.currentTarget.value as LoadDirectionLabel)}>
          {AXIS_DIRECTIONS.map((option) => <option key={option} value={option}>{directionOptionLabel(option)}</option>)}
        </select>
      ) : null}
    </div>
  );
}

const PAYLOAD_CATEGORY_ORDER: PayloadMaterialCategory[] = ["metal", "plastic", "composite", "resin", "ceramic-glass", "semiconductor", "rubber", "wood", "concrete-stone", "liquid", "misc"];

function PayloadMassControls({
  unitSystem,
  payloadObject,
  payloadMaterialId,
  payloadMassMode,
  manualMassKg,
  onPayloadMaterialChange,
  onPayloadMassModeChange,
  onManualMassChange
}: {
  unitSystem: UnitSystem;
  payloadObject: PayloadObjectSelection | null;
  payloadMaterialId: string;
  payloadMassMode: PayloadMassMode;
  manualMassKg: number;
  onPayloadMaterialChange: (materialId: string) => void;
  onPayloadMassModeChange: (mode: PayloadMassMode) => void;
  onManualMassChange: (displayValue: number) => void;
}) {
  const materialListId = useId();
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const [materialQuery, setMaterialQuery] = useState(selectedPayloadMaterial.name);
  const displayManualMass = loadValueForUnits(manualMassKg, "kg", unitSystem);
  const volumeSource = payloadObject?.volumeStatus === "estimated" ? "estimated from bounds" : payloadObject?.volumeSource ?? "not available";

  useEffect(() => {
    setMaterialQuery(selectedPayloadMaterial.name);
  }, [selectedPayloadMaterial.name]);

  function handleMaterialInput(value: string) {
    setMaterialQuery(value);
    const exactMaterial = payloadMaterials.find((material) => material.name.toLowerCase() === value.trim().toLowerCase());
    if (exactMaterial && exactMaterial.id !== payloadMaterialId) {
      onPayloadMaterialChange(exactMaterial.id);
    }
  }

  return (
    <>
      <label className="field">
        <HelpLabel helpId="loadMagnitude">Payload material</HelpLabel>
        <input
          list={materialListId}
          value={materialQuery}
          onChange={(event) => handleMaterialInput(event.currentTarget.value)}
          onBlur={() => setMaterialQuery(payloadMaterialForId(payloadMaterialId).name)}
        />
        <datalist id={materialListId}>
          {PAYLOAD_CATEGORY_ORDER.flatMap((category) =>
            payloadMaterials
              .filter((material) => material.category === category)
              .map((material) => (
                <option key={material.id} value={material.name} />
              ))
          )}
        </datalist>
      </label>
      <Info label="Payload volume" value={payloadObject?.volumeM3 ? `${formatVolume(payloadObject.volumeM3, "m^3", unitSystem)} · ${volumeSource}` : "Select a closed object or use manual mass"} />
      <Callout>Disconnected payload objects are carried weight, not bonded structure. Add each rod or carried part separately; unselected objects do not add weight to the solve.</Callout>
      <label className="toggle material-print-toggle">
        <input
          type="checkbox"
          checked={payloadMassMode === "manual"}
          onChange={(event) => onPayloadMassModeChange(event.currentTarget.checked ? "manual" : "material")}
        />
        <span>
          <strong>Manual mass override</strong>
          <small>Use a measured mass instead of material density times model volume.</small>
        </span>
      </label>
      {payloadMassMode === "manual" && (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">Payload mass</HelpLabel>
          <span className="input-with-unit">
            <input type="number" value={formatInputValue(displayManualMass.value)} onChange={(event) => onManualMassChange(Number(event.currentTarget.value))} />
            <span>{displayManualMass.units}</span>
          </span>
        </label>
      )}
    </>
  );
}

function LoadCasesEditor({ studyType, loadCases, loadCombinations, onChange }: {
  studyType: "static_stress" | "dynamic_structural";
  loadCases: LoadCase[];
  loadCombinations: LoadCombination[];
  onChange: (loadCases: LoadCase[], loadCombinations: LoadCombination[]) => void;
}) {
  const referencedCaseIds = new Set(loadCombinations.flatMap((combination) => combination.factors.map((factor) => factor.caseId)));
  const updateCase = (caseId: string, patch: Partial<LoadCase>) => onChange(
    loadCases.map((loadCase) => loadCase.id === caseId ? { ...loadCase, ...patch } : loadCase),
    loadCombinations
  );
  const updateCombination = (combinationId: string, patch: Partial<LoadCombination>) => onChange(
    loadCases,
    loadCombinations.map((combination) => combination.id === combinationId ? { ...combination, ...patch } : combination)
  );
  return (
    <section className="load-case-editor" aria-label="Load cases">
      {loadCases.map((loadCase) => {
        const canDelete = loadCases.length > 1 && loadCase.loadIds.length === 0 && !referencedCaseIds.has(loadCase.id);
        return (
          <div className="load-case-row" key={loadCase.id}>
            <input aria-label={`Load case name ${loadCase.name}`} value={loadCase.name} onChange={(event) => updateCase(loadCase.id, { name: event.currentTarget.value || "Untitled case" })} />
            {/* An enabled empty case blocks the run; say so where it was made, not only on Run. */}
            <small className={loadCase.enabled && loadCase.loadIds.length === 0 ? "load-case-empty" : undefined} title={loadCase.enabled && loadCase.loadIds.length === 0 ? "Enabled cases need at least one load. Assign a load or turn the case off." : undefined}>{loadCase.loadIds.length} load{loadCase.loadIds.length === 1 ? "" : "s"}</small>
            <label className="toggle compact-toggle">
              <input type="checkbox" aria-label={`Enable load case ${loadCase.name}`} checked={loadCase.enabled} onChange={(event) => updateCase(loadCase.id, { enabled: event.currentTarget.checked })} />
              <span>Enabled</span>
            </label>
            <button type="button" className="remove-glyph" aria-label={`Delete load case ${loadCase.name}`} disabled={!canDelete} onClick={() => onChange(loadCases.filter((candidate) => candidate.id !== loadCase.id), loadCombinations)}><X size={15} /></button>
          </div>
        );
      })}
      <button className="outline-action wide" type="button" onClick={() => onChange([
        ...loadCases,
        { id: `case-${crypto.randomUUID()}`, name: `Case ${loadCases.length + 1}`, enabled: true, loadIds: [] }
      ], loadCombinations)}><Plus size={16} />Add load case</button>
      {studyType === "static_stress" && (
        <>
          <SectionTitle helpId="loadCombinations">Combinations</SectionTitle>
          {loadCombinations.map((combination) => (
            <div className="load-combination-row" key={combination.id}>
              <input aria-label={`Combination name ${combination.name}`} value={combination.name} onChange={(event) => updateCombination(combination.id, { name: event.currentTarget.value || "Untitled combination" })} />
              <label className="toggle compact-toggle">
                <input type="checkbox" aria-label={`Enable combination ${combination.name}`} checked={combination.enabled} onChange={(event) => updateCombination(combination.id, { enabled: event.currentTarget.checked })} />
                <span>Enabled</span>
              </label>
              {combination.factors.map((factor) => (
                <label className="combination-factor" key={factor.caseId}>
                  <span>{loadCases.find((loadCase) => loadCase.id === factor.caseId)?.name ?? factor.caseId}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={factor.factor}
                    onChange={(event) => updateCombination(combination.id, {
                      factors: combination.factors.map((candidate) => candidate.caseId === factor.caseId
                        ? { ...candidate, factor: Number.isFinite(Number(event.currentTarget.value)) ? Number(event.currentTarget.value) : 0 }
                        : candidate)
                    })}
                  />
                </label>
              ))}
              <button type="button" className="text-button danger-text load-combination-delete" onClick={() => onChange(loadCases, loadCombinations.filter((candidate) => candidate.id !== combination.id))}>Delete combination</button>
            </div>
          ))}
          <button className="outline-action wide" type="button" disabled={!loadCases.length} onClick={() => onChange(loadCases, [
            ...loadCombinations,
            {
              id: `combination-${crypto.randomUUID()}`,
              name: `Combination ${loadCombinations.length + 1}`,
              enabled: true,
              factors: loadCases.slice(0, 2).map((loadCase) => ({ caseId: loadCase.id, factor: 1 }))
            }
          ])}><Plus size={16} />Add combination</button>
        </>
      )}
    </section>
  );
}

function LoadEditorList({ editingId, onEditingIdChange, study, displayModel, unitSystem, loadCases, retargetFace, onAssignLoadToCase, onUpdateLoad, onPreviewLoadEdit, onRemoveLoad }: { editingId: string | null; onEditingIdChange: (loadId: string | null) => void; study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; loadCases: LoadCase[]; retargetFace?: DisplayFace | null; onAssignLoadToCase: (loadId: string, caseId: string) => void; onUpdateLoad: (load: Load, targetFace?: DisplayFace) => void; onPreviewLoadEdit: (load: Load | null) => void; onRemoveLoad: (loadId: string) => void }) {
  const loadItemRefs = useRef(new Map<string, HTMLButtonElement>());
  if (!study.loads.length) return <EmptyEditableList title="Loads" />;
  const loadLabelsById = new Map(createViewerLoadMarkers({ study, displayModel }).map((marker) => [marker.id, loadMarkerOrdinalLabel(marker)]));

  function finishEditing(loadId: string) {
    onEditingIdChange(null);
    window.requestAnimationFrame(() => loadItemRefs.current.get(loadId)?.focus());
  }

  return (
    <div className="editable-list">
      <h3>Loads</h3>
      {study.loads.map((load) => {
        const editing = editingId === load.id;
        const units = String(load.parameters.units ?? unitsForLoadType(load.type));
        const displayLoad = loadValueForUnits(Number(load.parameters.value ?? 0), units, unitSystem);
        const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
        const selectedFace = displayModel.faces.find((candidate) => candidate.id === selection?.geometryRefs[0]?.entityId);
        // Multi-face loads list every face, not only the first (Decision 2).
        const faceNames = entryFaceNames(study, displayModel, load, unitSystem);
        const label = `${entryNamedSelectionPrefix(study, load)}${faceNames[0]}${additionalFaceCountLabel(faceNames)}`;
        const payloadObject = payloadObjectForLoad(load);
        const payloadMaterial = load.type === "gravity" && typeof load.parameters.payloadMaterialId === "string" ? payloadMaterialForId(load.parameters.payloadMaterialId).name : "";
        // A face force's picked point is only where its arrow is drawn; the solve
        // spreads the total over the face, so it is not described as a point load.
        const pointLabel = payloadObject
          ? ` · ${payloadObject.label}${payloadMaterial ? ` · ${payloadMaterial}` : ""}`
          : load.type === "remote_force" ? " · via remote point" : "";
        const equivalentForce = load.type === "gravity" ? ` · ${formatEquivalentForce(equivalentForceForLoad(load), unitSystem)} weight` : "";
        const loadLabel = loadLabelsById.get(load.id);
        const loadCaseId = loadCases.find((loadCase) => loadCase.loadIds.includes(load.id))?.id ?? loadCases[0]?.id ?? "";
        const editLabel = `Edit ${loadLabel ? `${loadLabel} ` : ""}${load.type} load`;
        const beginEdit = () => onEditingIdChange(load.id);
        return (
          <div className="editable-item load-item" key={load.id}>
            {/* The row's summary is a real button, sibling to Remove and to the
                load-case select. It used to be a div[role=button] wrapping
                them, which nests interactive content inside a control. */}
            <div className="editable-summary">
              <button
                className="editable-summary-trigger"
                type="button"
                ref={(node) => {
                  if (node) loadItemRefs.current.set(load.id, node);
                  else loadItemRefs.current.delete(load.id);
                }}
                aria-label={editLabel}
                aria-expanded={editing}
                disabled={editing}
                onClick={beginEdit}
              >
                <span className={`item-icon load-type-icon ${load.type}`}><LoadTypeIcon type={load.type} /></span>
                <strong>{loadLabel ? `${loadLabel} · ` : ""}{loadTypeLabel(load.type)} · {formatNumber(displayLoad.value)} {displayLoad.units}</strong>
                <small>{load.type === "heat_flux" || load.type === "heat_generation"
                  ? label
                  : `${label}${pointLabel} · ${loadDirectionDescription(load, displayModel, selectedFace)}${equivalentForce}`}</small>
              </button>
              {loadCases.length > 1 && (
                <label className="load-case-assignment">
                  <span>Case</span>
                  <select value={loadCaseId} onChange={(event) => onAssignLoadToCase(load.id, event.currentTarget.value)}>
                    {loadCases.map((loadCase) => <option key={loadCase.id} value={loadCase.id}>{loadCase.name}</option>)}
                  </select>
                </label>
              )}
              <button
                className="remove-glyph"
                type="button"
                aria-label={`Remove ${loadTypeLabel(load.type)} load`}
                onClick={() => onRemoveLoad(load.id)}
              >
                <X size={16} />
              </button>
            </div>
            <EntryFaceList names={faceNames} note={multiFaceLoadRowNote(load.type)} />
            {editing ? (
              <LoadEditForm
                load={load}
                study={study}
                displayModel={displayModel}
                unitSystem={unitSystem}
                accessibleName={`${loadLabel ?? loadTypeLabel(load.type)} load editor`}
                retargetFace={retargetFace}
                onPreviewChange={onPreviewLoadEdit}
                onCancel={() => finishEditing(load.id)}
                onSave={(nextLoad, targetFace) => {
                  onPreviewLoadEdit(null);
                  onUpdateLoad(nextLoad, targetFace);
                  finishEditing(load.id);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function LoadEditForm({ load, study, displayModel, unitSystem, accessibleName, retargetFace, onSave, onCancel, onPreviewChange }: { load: Load; study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; accessibleName: string; retargetFace?: DisplayFace | null; onSave: (load: Load, targetFace?: DisplayFace) => void; onCancel: () => void; onPreviewChange: (load: Load | null) => void }) {
  const [type, setType] = useState<LoadType>(load.type);
  // Re-targeting (2026-09 review D3): a face picked while editing can become
  // the new target; the direction preview follows it.
  const [moveToPicked, setMoveToPicked] = useState(false);
  const [value, setValue] = useState(() => {
    const initialUnits = String(load.parameters.units ?? unitsForLoadType(load.type));
    return formatInputValue(loadValueForUnits(Number(load.parameters.value ?? 500), initialUnits, unitSystem).value);
  });
  const selectedRef = study.namedSelections.find((selection) => selection.id === load.selectionRef);
  const selectionIsBody = selectedRef?.entityType === "body";
  const selectedFace = selectedRef?.geometryRefs[0];
  const selectedDisplayFace = displayModel.faces.find((face) => face.id === selectedFace?.entityId);
  const [direction, setDirection] = useState<LoadDirectionLabel>(() => storedLoadDirectionLabel(load, displayModel, selectedDisplayFace));
  const [payloadMaterialId, setPayloadMaterialId] = useState(String(load.parameters.payloadMaterialId ?? "payload-steel"));
  const [payloadMassMode, setPayloadMassMode] = useState<PayloadMassMode>(load.parameters.payloadMassMode === "manual" ? "manual" : "material");
  const [remotePoint, setRemotePoint] = useState<LoadApplicationPoint>(() => finiteVector3(load.parameters.remotePoint) ?? selectedDisplayFace?.center ?? [0, 0, 0]);
  const secondaryFaceOptions = useMemo(
    () => study.namedSelections.filter((selection) => selection.entityType === "face" && selection.id !== load.selectionRef),
    [load.selectionRef, study.namedSelections]
  );
  const [secondarySelectionRef, setSecondarySelectionRef] = useState(typeof load.parameters.secondarySelectionRef === "string" ? load.parameters.secondarySelectionRef : secondaryFaceOptions[0]?.id ?? "");
  const units = unitsForLoadType(type);
  const displayUnits = loadValueForUnits(defaultValueForLoadType(type), units, unitSystem).units;
  const payloadObject = payloadObjectForLoad(load) ?? null;
  const payloadVolumeM3 = positiveNumber(load.parameters.payloadVolumeM3) ? load.parameters.payloadVolumeM3 : payloadObject?.volumeM3;
  const calculatedPayloadMass = payloadVolumeM3 ? massKgForPayloadMaterial(payloadMaterialId, payloadVolumeM3) : 0;
  const manualMassKg = loadValueForUnits(Number(value), displayUnits, "SI").value;
  const editedValue = type === "gravity" && payloadMassMode === "material" && calculatedPayloadMass > 0 ? calculatedPayloadMass : manualMassKg;
  // Memoized on scalar inputs: a fresh object here would retrigger the preview effect every render and loop with the parent setState.
  const payloadMetadata = useMemo<PayloadLoadMetadata>(() => type === "gravity"
    ? { payloadMaterialId, ...(payloadVolumeM3 ? { payloadVolumeM3 } : {}), payloadMassMode }
    : type === "remote_force"
      ? { remotePoint }
      : type === "bolt_preload"
        ? { secondarySelectionRef }
        : {}, [payloadMassMode, payloadMaterialId, payloadVolumeM3, remotePoint, secondarySelectionRef, type]);
  const selectedPayloadMaterial = payloadMaterialForId(payloadMaterialId);
  const pickedElsewhere = retargetFace && !selectionIsBody && retargetFace.id !== selectedFace?.entityId ? retargetFace : null;
  // The stored face label carries the importer's mm² suffix; show it in the project's units.
  const pickedFaceLabel = pickedElsewhere ? stepFaceLabelForUnits(pickedElsewhere.label, pickedElsewhere.area, unitSystem) : "";
  const targetFace = moveToPicked && pickedElsewhere ? pickedElsewhere : undefined;
  const directionFace: DisplayFace = useMemo(() => targetFace ?? selectedDisplayFace ?? ({
    id: selectedFace?.entityId ?? "selected-face",
    label: selectedFace?.label ?? "selected face",
    color: "#fff",
    center: [0, 0, 0],
    normal: [0, 1, 0],
    stressValue: 0
  }), [selectedDisplayFace, selectedFace?.entityId, selectedFace?.label, targetFace]);
  const previewLoad = useMemo(() => editedLoadForForm(load, type, value, displayUnits, units, direction, directionFace, displayModel, payloadMetadata, editedValue), [direction, directionFace, displayModel, displayUnits, editedValue, load, payloadMetadata, type, units, value]);
  const magnitudeError = loadMagnitudeError(editedValue, study.type);
  const opposingFaceError = type === "bolt_preload" && (!secondarySelectionRef || secondarySelectionRef === load.selectionRef)
    ? "Choose a different opposing face."
    : null;
  const remotePointError = type === "remote_force" && !remotePoint.every((component) => Number.isFinite(component))
    ? "Remote point coordinates must be numbers."
    : null;
  const saveBlockedBy = magnitudeError ?? opposingFaceError ?? remotePointError;
  const magnitudeErrorId = `${load.id}-magnitude-error`;

  useEffect(() => {
    onPreviewChange(previewLoad);
    return () => onPreviewChange(null);
  }, [onPreviewChange, previewLoad]);

  return (
    <div className="edit-form" role="group" aria-label={accessibleName}>
      <label className="field">
        <HelpLabel helpId="loadType">Load type</HelpLabel>
        <select value={type} onChange={(event) => setType(event.currentTarget.value as LoadType)}>
          {selectionIsBody ? (
            <>
              <option value="volume_force">Volume force</option>
              <option value="gravity">Payload mass</option>
            </>
          ) : (
            <>
              <option value="force">Face force (total)</option>
              <option value="pressure">Pressure</option>
              <option value="surface_traction">Surface traction</option>
              <option value="remote_force">Remote force</option>
              {study.type === "static_stress" ? <option value="bolt_preload">Equivalent bolt preload</option> : null}
            </>
          )}
        </select>
      </label>
      {type === "gravity" ? (
        <>
          <PayloadMassControls
            unitSystem={unitSystem}
            payloadObject={payloadObject}
            payloadMaterialId={payloadMaterialId}
            payloadMassMode={payloadMassMode}
            manualMassKg={manualMassKg}
            onPayloadMaterialChange={setPayloadMaterialId}
            onPayloadMassModeChange={setPayloadMassMode}
            onManualMassChange={(displayValue) => setValue(formatInputValue(displayValue))}
          />
          <Info label="Selected density" value={formatDensity(selectedPayloadMaterial.density, "kg/m^3", unitSystem)} />
          <Info label="Calculated mass" value={formatMass(calculatedPayloadMass, "kg", unitSystem)} />
          <Callout>{formatEquivalentForce(equivalentForceForLoad({ type: "gravity", parameters: { value: editedValue } }), unitSystem)} equivalent weight.</Callout>
        </>
      ) : (
        <label className="field">
          <HelpLabel helpId="loadMagnitude">Magnitude</HelpLabel>
          <span className="input-with-unit">
            <input
              type="number"
              value={value}
              aria-invalid={magnitudeError ? true : undefined}
              aria-describedby={magnitudeError ? magnitudeErrorId : undefined}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
            <span>{displayUnits}</span>
          </span>
        </label>
      )}
      {magnitudeError && <p className="field-error" id={magnitudeErrorId} role="alert">{magnitudeError}</p>}
      <PlacementReadout selectedRef={selectedRef} label={selectedRef ? selectionDisplayName(study, displayModel, selectedRef.id, unitSystem) : undefined} />
      {type === "remote_force" ? (
        <fieldset className="field"><legend>Remote point coordinates ({REMOTE_POINT_UNIT_LABEL})</legend>
          <RemotePointInputs point={remotePoint} onChange={setRemotePoint} />
          <small>{remotePointFrameNote(unitSystem)}</small>
        </fieldset>
      ) : null}
      {type === "bolt_preload" ? (
        <label className="field">Opposing face<select value={secondarySelectionRef} onChange={(event) => setSecondarySelectionRef(event.currentTarget.value)}>
          <option value="">Choose a different face</option>
          {secondaryFaceOptions.map((selection) => <option key={selection.id} value={selection.id}>{selection.name}</option>)}
        </select></label>
      ) : null}
      <label className="field">
        <HelpLabel helpId="loadDirection">Direction</HelpLabel>
        <select value={direction} onChange={(event) => setDirection(event.currentTarget.value as LoadDirectionLabel)}>
          {LOAD_DIRECTION_LABELS.map((option) => (
            <option key={option} value={option}>{directionOptionLabel(option)}</option>
          ))}
        </select>
      </label>
      {pickedElsewhere && (
        <label className="toggle">
          <input type="checkbox" aria-label={`Move to ${pickedFaceLabel}`} checked={moveToPicked} onChange={(event) => setMoveToPicked(event.currentTarget.checked)} />
          <span>Move to {pickedFaceLabel} (picked in the viewer)</span>
        </label>
      )}
      <div className="edit-actions">
        <button
          className="primary"
          type="button"
          disabled={Boolean(saveBlockedBy)}
          title={saveBlockedBy ?? undefined}
          onClick={() => !saveBlockedBy && onSave(previewLoad, targetFace)}
        >
          Save
        </button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function editedLoadForForm(load: Load, type: LoadType, value: string, displayUnits: string, units: string, direction: LoadDirectionLabel, directionFace: DisplayFace, displayModel: DisplayModel, payloadMetadata: PayloadLoadMetadata = {}, overrideValue?: number): Load {
  return {
    ...load,
    type,
    parameters: {
      ...load.parameters,
      value: overrideValue ?? loadValueForUnits(Number(value), displayUnits, "SI").value,
      units,
      direction: directionVectorForLabel(direction, directionFace, displayModel),
      directionMode: direction,
      ...(type === "gravity" || type === "remote_force" || type === "bolt_preload" ? payloadMetadata : {})
    }
  };
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteVector3(value: unknown): LoadApplicationPoint | null {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0], value[1], value[2]]
    : null;
}

/**
 * Support summary in project units. Values are stored canonically — °C for a
 * boundary temperature, mm for a prescribed displacement — which is what the
 * adapter reads regardless of the stored `units` text.
 */
function supportValueLabel(support: Constraint, unitSystem: UnitSystem, faces: readonly DisplayFace[] = []): string {
  const structural = structuralSupportDescription(support, faces);
  if (structural) return structural;
  const value = Number(support.parameters.value ?? 0);
  if (support.type === "prescribed_temperature") {
    const temperature = temperatureForUnits(value, "°C", unitSystem);
    return `Prescribed temperature (${formatDisplayNumber(temperature.value)}\u00a0${temperature.units})`;
  }
  const displacement = lengthForUnits(value, "mm", unitSystem);
  return `Prescribed displacement (${formatDisplayNumber(displacement.value)}\u00a0${displacement.units} ${String(support.parameters.component ?? "z")})`;
}

/** A support that stops being fixed drops its fixed-only component list. */
function withoutFixedComponents(parameters: Record<string, unknown>): Record<string, unknown> {
  const { components: _components, ...rest } = parameters;
  return rest;
}

function multiFaceLoadRowNote(type: LoadType): string | null {
  if (type === "force") return "total force shared by area";
  if (type === "remote_force") return "force and moment shared over the combined area";
  if (type === "pressure" || type === "surface_traction") return "full value on each face";
  return null;
}

function SupportEditorList({ study, displayModel, unitSystem, retargetFace, onUpdateSupport, onRemoveSupport }: { study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; retargetFace?: DisplayFace | null; onUpdateSupport: (support: Constraint, targetFace?: DisplayFace) => void; onRemoveSupport: (supportId: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Mirrors the load rows: closing the form must return focus to the control
  // that opened it, or the form's unmount drops focus to <body>.
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  if (!study.constraints.length) return <EmptyEditableList title="Supports" />;

  function finishEditing(supportId: string) {
    setEditingId(null);
    window.requestAnimationFrame(() => editButtonRefs.current.get(supportId)?.focus());
  }

  let fixedSupportCount = 0;
  let prescribedSupportCount = 0;
  let thermalSupportCount = 0;
  let symmetrySupportCount = 0;
  const supportItems = study.constraints.map((support) => {
    const supportOrdinal = support.type === "fixed" ? ++fixedSupportCount : support.type === "prescribed_temperature" ? ++thermalSupportCount : support.type === "symmetry" ? ++symmetrySupportCount : ++prescribedSupportCount;
    return { support, displayLabel: supportDisplayLabel(support, supportOrdinal) };
  });

  return (
    <div className="editable-list">
      <h3>Supports</h3>
      {supportItems.map(({ support, displayLabel }) => {
        const editing = editingId === support.id;
        // Multi-face supports list every face, not only the first (Decision 2).
        const faceNames = entryFaceNames(study, displayModel, support, unitSystem);
        return (
          <div className="editable-item" key={support.id}>
            <div className="editable-summary">
              <span className="item-icon warning"><SupportIcon /></span>
              <strong>{displayLabel} · {supportValueLabel(support, unitSystem, displayFacesForEntry(study, displayModel, support))}</strong>
              <small>{entryNamedSelectionPrefix(study, support)}{faceNames[0]}{additionalFaceCountLabel(faceNames)}</small>
              <button className="remove-glyph" type="button" aria-label="Remove support" onClick={() => onRemoveSupport(support.id)}><X size={16} /></button>
            </div>
            <EntryFaceList names={faceNames} />
            {editing ? (
              <SupportEditForm
                support={support}
                study={study}
                displayModel={displayModel}
                unitSystem={unitSystem}
                retargetFace={retargetFace}
                onCancel={() => finishEditing(support.id)}
                onSave={(nextSupport, targetFace) => {
                  onUpdateSupport(nextSupport, targetFace);
                  finishEditing(support.id);
                }}
              />
            ) : (
              <button
                className="secondary wide"
                type="button"
                ref={(node) => {
                  if (node) editButtonRefs.current.set(support.id, node);
                  else editButtonRefs.current.delete(support.id);
                }}
                onClick={() => setEditingId(support.id)}
              >
                Edit support
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LoadTypeIcon({ type }: { type: LoadType }) {
  if (type === "pressure" || type === "surface_traction") return <Gauge size={16} />;
  if (type === "gravity") return <Weight size={16} />;
  return <ScanLine size={16} />;
}

export function SupportEditForm({ support, study, displayModel, unitSystem, retargetFace, onSave, onCancel }: { support: Constraint; study: Study; displayModel: DisplayModel; unitSystem: UnitSystem; retargetFace?: DisplayFace | null; onSave: (support: Constraint, targetFace?: DisplayFace) => void; onCancel: () => void }) {
  const thermal = study.type === "steady_state_thermal";
  const [type, setType] = useState<Constraint["type"]>(support.type);
  const [temperature, setTemperature] = useState(Number(support.parameters.value ?? 20));
  const [displacementValueMm, setDisplacementValueMm] = useState(Number(support.parameters.value ?? 0));
  const [displacementComponent, setDisplacementComponent] = useState<"x" | "y" | "z">(
    support.parameters.component === "x" || support.parameters.component === "y" || support.parameters.component === "z"
      ? support.parameters.component
      : "z"
  );
  const [components, setComponents] = useState<SupportComponent[]>(support.type === "fixed" ? fixedSupportComponents(support) : [...SUPPORT_COMPONENTS]);
  const selectedRef = study.namedSelections.find((selection) => selection.id === support.selectionRef);
  // Re-targeting (2026-09 review D3): a face picked while editing can become
  // the new target; before, the pick added a second support instead.
  const [moveToPicked, setMoveToPicked] = useState(false);
  const pickedElsewhere = retargetFace && !selectedRef?.geometryRefs.some((ref) => ref.entityId === retargetFace.id) ? retargetFace : null;
  const pickedFaceLabel = pickedElsewhere ? stepFaceLabelForUnits(pickedElsewhere.label, pickedElsewhere.area, unitSystem) : "";
  const targetFace = moveToPicked && pickedElsewhere ? pickedElsewhere : undefined;
  function savedParameters(): Record<string, unknown> {
    if (thermal) return { ...support.parameters, value: temperature, units: "°C" };
    if (type === "prescribed_displacement") return { ...support.parameters, value: displacementValueMm, units: "mm", component: displacementComponent };
    // Holding all three components stores no list, exactly like a pre-R1.4 support.
    if (type === "fixed") return fixedSupportParameters(support.parameters, components);
    return withoutFixedComponents(support.parameters);
  }
  return (
    <div className="edit-form">
      {pickedElsewhere && (
        <label className="toggle">
          <input type="checkbox" aria-label={`Move to ${pickedFaceLabel}`} checked={moveToPicked} onChange={(event) => setMoveToPicked(event.currentTarget.checked)} />
          <span>Move to {pickedFaceLabel} (picked in the viewer)</span>
        </label>
      )}
      <label className="field">
        <HelpLabel helpId="supportType">Support type</HelpLabel>
        <select value={type} onChange={(event) => setType(event.currentTarget.value as Constraint["type"])}>
          {thermal
            ? <option value="prescribed_temperature">Prescribed temperature</option>
            : <>
              <option value="fixed">Fixed support</option>
              <option value="symmetry">Symmetry / roller</option>
              {(study.type !== "modal_analysis" || type === "prescribed_displacement") && <option value="prescribed_displacement">Prescribed displacement</option>}
            </>}
        </select>
      </label>
      {thermal && <TemperatureField valueCelsius={temperature} unitSystem={unitSystem} onChange={setTemperature} />}
      {!thermal && type === "fixed" && <FixedComponentsField components={components} onChange={setComponents} />}
      {!thermal && type === "symmetry" && <p className="field-note">{SYMMETRY_SUPPORT_TOLERANCE_NOTE}</p>}
      {!thermal && type === "prescribed_displacement" && (
        <>
          <DisplacementField valueMm={displacementValueMm} unitSystem={unitSystem} onChange={setDisplacementValueMm} />
          <label className="field">Component
            <select value={displacementComponent} onChange={(event) => setDisplacementComponent(event.currentTarget.value as "x" | "y" | "z")}>
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
          </label>
        </>
      )}
      <PlacementReadout selectedRef={selectedRef} label={selectedRef ? selectionDisplayName(study, displayModel, selectedRef.id, unitSystem) : undefined} />
      <div className="edit-actions">
        <button className="primary" type="button" disabled={(thermal && !Number.isFinite(temperature)) || (!thermal && type === "prescribed_displacement" && !Number.isFinite(displacementValueMm)) || (!thermal && type === "fixed" && components.length === 0)} onClick={() => onSave({ ...support, type, parameters: savedParameters() }, targetFace)}>Save</button>
        <button className="secondary" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
