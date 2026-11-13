import { useMemo, useState } from "react";
import type { DisplayFace } from "@openfea/schema";
import { highlightedSelectionFaceIds, pickIntentForModifiers, selectionChipText, selectionCountLabel, type PickIntent, type PickModifiers } from "./selection";

export const MAX_A11Y_FACE_BUTTONS = 256;

/** A face button activation toggles while "Add to selection" is on, or when Ctrl/Cmd is held; otherwise it picks. */
export function faceButtonPickIntent(addToSelection: boolean, modifiers: PickModifiers | null | undefined): PickIntent {
  return addToSelection ? "toggle" : pickIntentForModifiers(modifiers);
}

/**
 * The viewer's keyboard face list and selection chip (plan 036 R1.2).
 *
 * The face buttons are the keyboard equivalent of picking in the canvas: a
 * plain activation picks the face, and with "Add to selection" ticked (or
 * Ctrl/Cmd held while clicking) activation adds or removes it, like Ctrl/Cmd-
 * click on the model. Each button's pressed state says whether the face is in
 * the working selection. The chip names the primary face and announces how
 * many faces are selected.
 */
export function FaceSelectionOverlay({
  faces,
  selectedFaceId,
  additionalSelectedFaceIds,
  showSelectionChip,
  formatFaceLabel = (face) => face.label || face.id,
  onSelectFace
}: {
  faces: readonly DisplayFace[];
  /** How a face is named on its button and in the chip (the viewer passes a project-units formatter). */
  formatFaceLabel?: (face: DisplayFace) => string;
  selectedFaceId: string | null;
  additionalSelectedFaceIds?: readonly string[];
  showSelectionChip: boolean;
  onSelectFace: (face: DisplayFace, intent: PickIntent) => void;
}) {
  const [addToSelection, setAddToSelection] = useState(false);
  const selectedIds = useMemo(
    () => highlightedSelectionFaceIds(selectedFaceId, additionalSelectedFaceIds),
    [additionalSelectedFaceIds, selectedFaceId]
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const primaryFace = selectedFaceId ? faces.find((face) => face.id === selectedFaceId) : undefined;
  const primaryLabel = primaryFace?.label ? formatFaceLabel(primaryFace) : null;
  const additionalCount = selectedIds.length - (selectedFaceId ? 1 : 0);
  const chipText = primaryLabel
    ? selectionChipText(primaryLabel, additionalCount)
    : additionalCount > 0 ? selectionCountLabel(additionalCount) : null;
  return (
    <>
      {faces.length > 0 && (
        <div className="viewer-a11y-faces" role="group" aria-label="Select a face with the keyboard">
          <span>Select a face to place supports or loads. Hold Ctrl (⌘ on Mac) while clicking, or turn on Add to selection, to select several.</span>
          <label className="viewer-a11y-faces-mode">
            <input type="checkbox" checked={addToSelection} onChange={(event) => setAddToSelection(event.currentTarget.checked)} />
            Add to selection
          </label>
          {faces.slice(0, MAX_A11Y_FACE_BUTTONS).map((face) => (
            <button
              key={face.id}
              type="button"
              aria-pressed={selected.has(face.id)}
              onClick={(event) => onSelectFace(face, faceButtonPickIntent(addToSelection, event))}
            >
              {formatFaceLabel(face)}
            </button>
          ))}
          {faces.length > MAX_A11Y_FACE_BUTTONS ? <span>Use pointer selection for additional faces.</span> : null}
        </div>
      )}
      {showSelectionChip && chipText ? (
        <div className="viewer-selection-chip" role="status" aria-live="polite">
          <span className="viewer-selection-dot" aria-hidden="true" />Selected: {chipText}
          {selectedIds.length > 1 ? <span className="visually-hidden">. {selectionCountLabel(selectedIds.length)}</span> : null}
        </div>
      ) : null}
    </>
  );
}
