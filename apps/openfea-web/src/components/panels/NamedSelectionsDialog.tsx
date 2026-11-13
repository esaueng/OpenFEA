import { useId, useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { Study } from "@openfea/schema";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { managedNamedSelections, MAX_NAMED_SELECTION_NAME_LENGTH, namedSelectionUsage, selectionFaceIds } from "../../namedSelections";
import { selectionCountLabel } from "../viewer/selection";

/**
 * What the workspace lets the Supports and Loads panels do with named
 * selections (plan 036 R1.2). Each action returns an error message, or null
 * when it succeeded.
 */
export type NamedSelectionManagerActions = {
  /** Display names of the faces in the working selection, primary first. */
  selectedFaceNames: readonly string[];
  /** The named selection the working selection currently reuses, if any. */
  boundSelectionId: string | null;
  onCreate: (name: string) => string | null;
  onRename: (selectionId: string, name: string) => string | null;
  onDelete: (selectionId: string) => string | null;
  /** Load a named selection into the working selection so the next Add applies to it. */
  onUse: (selectionId: string) => void;
};

/** The face count line and the button that opens the manager, shown above a panel's Add button. */
export function WorkingSelectionBar({ study, manager }: { study: Study; manager: NamedSelectionManagerActions }) {
  const [open, setOpen] = useState(false);
  const bound = manager.boundSelectionId ? managedNamedSelections(study).find((selection) => selection.id === manager.boundSelectionId) : undefined;
  const count = bound ? selectionFaceIds(study, bound.id).length : manager.selectedFaceNames.length;
  return (
    <div className="working-selection">
      <span className="working-selection-count">
        {selectionCountLabel(count)}{bound ? ` · ${bound.name}` : ""}
      </span>
      <button type="button" className="text-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>Named selections…</button>
      {open ? <NamedSelectionsDialog study={study} manager={manager} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * Create, rename, reuse and delete named selections. Keyboard: Tab moves
 * through the form and each row's actions, Enter submits, Escape cancels a
 * rename first and closes the dialog otherwise. Delete is only offered for a
 * selection nothing uses.
 */
export function NamedSelectionsDialog({ study, manager, onClose }: { study: Study; manager: NamedSelectionManagerActions; onClose: () => void }) {
  const baseId = useId();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renamingId;
  const dialogRef = useFocusTrap<HTMLElement>(true, () => {
    if (renamingRef.current) cancelRename();
    else onClose();
  });
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const selections = managedNamedSelections(study);
  const faceNames = manager.selectedFaceNames;
  const titleId = `${baseId}-title`;
  const nameId = `${baseId}-name`;
  const createErrorId = `${baseId}-create-error`;
  const renameErrorId = `${baseId}-rename-error`;

  function focusById(id: string) {
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    const error = manager.onCreate(name);
    setCreateError(error);
    if (!error) {
      setNotice(`Saved ${name.trim()} with ${faceNames.length} face${faceNames.length === 1 ? "" : "s"}.`);
      setName("");
    }
  }

  function startRename(selectionId: string, currentName: string) {
    setRenamingId(selectionId);
    setRenameValue(currentName);
    setRenameError(null);
    focusById(`${baseId}-rename-input`);
  }

  function cancelRename() {
    const selectionId = renamingRef.current;
    setRenamingId(null);
    setRenameError(null);
    if (selectionId) focusById(`${baseId}-rename-${selectionId}`);
  }

  function submitRename(event: FormEvent, selectionId: string) {
    event.preventDefault();
    const error = manager.onRename(selectionId, renameValue);
    setRenameError(error);
    if (error) return;
    setNotice(`Renamed to ${renameValue.trim()}.`);
    setRenamingId(null);
    focusById(`${baseId}-rename-${selectionId}`);
  }

  function remove(selectionId: string, selectionName: string) {
    const error = manager.onDelete(selectionId);
    setNotice(error ?? `Deleted ${selectionName}.`);
    if (!error) focusById(nameId);
  }

  return (
    <div className="workflow-modal-backdrop" role="presentation">
      <section ref={dialogRef} className="workflow-modal named-selections-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="workflow-modal-header">
          <h2 id={titleId}>Named selections</h2>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close named selections">
            <X size={18} />
          </button>
        </header>
        <div className="named-selections-body">
          <form className="named-selection-create" onSubmit={submitCreate}>
            <p className="panel-copy">
              {faceNames.length
                ? `${selectionCountLabel(faceNames.length)}: ${faceNames.join(", ")}.`
                : "No faces selected. Pick a face in the viewer, Ctrl-click (⌘-click on Mac) to add more, then save them here."}
            </p>
            <label className="field">Name
              <input
                id={nameId}
                type="text"
                value={name}
                maxLength={MAX_NAMED_SELECTION_NAME_LENGTH}
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? createErrorId : undefined}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            {createError ? <p className="field-error" id={createErrorId} role="alert">{createError}</p> : null}
            <button className="primary" type="submit" disabled={!faceNames.length}>Save selection</button>
          </form>
          <h3>Saved selections</h3>
          {selections.length ? (
            <ul className="named-selection-list">
              {selections.map((selection) => {
                const usage = namedSelectionUsage(study, selection.id);
                const faceCount = selectionFaceIds(study, selection.id).length;
                const usageId = `${baseId}-usage-${selection.id}`;
                const inUse = manager.boundSelectionId === selection.id;
                return (
                  <li key={selection.id} className="named-selection-row">
                    {renamingId === selection.id ? (
                      <form className="named-selection-rename" onSubmit={(event) => submitRename(event, selection.id)}>
                        <label className="visually-hidden" htmlFor={`${baseId}-rename-input`}>New name for {selection.name}</label>
                        <input
                          id={`${baseId}-rename-input`}
                          type="text"
                          value={renameValue}
                          maxLength={MAX_NAMED_SELECTION_NAME_LENGTH}
                          aria-invalid={renameError ? true : undefined}
                          aria-describedby={renameError ? renameErrorId : undefined}
                          onChange={(event) => setRenameValue(event.currentTarget.value)}
                        />
                        <button className="secondary" type="submit">Save</button>
                        <button className="secondary" type="button" onClick={cancelRename}>Cancel</button>
                        {renameError ? <p className="field-error" id={renameErrorId} role="alert">{renameError}</p> : null}
                      </form>
                    ) : (
                      <>
                        <div className="named-selection-summary">
                          <strong>{selection.name}</strong>
                          <small id={usageId}>
                            {faceCount} face{faceCount === 1 ? "" : "s"} · {usage.length ? `used by ${usage.join(", ")}` : "not used"}{inUse ? " · selected" : ""}
                          </small>
                        </div>
                        <div className="named-selection-actions">
                          <button className="secondary" type="button" aria-label={`Use ${selection.name}`} onClick={() => { manager.onUse(selection.id); onClose(); }}>Use</button>
                          <button className="secondary" type="button" id={`${baseId}-rename-${selection.id}`} aria-label={`Rename ${selection.name}`} onClick={() => startRename(selection.id, selection.name)}>Rename</button>
                          <button
                            className="secondary"
                            type="button"
                            aria-label={`Delete ${selection.name}`}
                            aria-describedby={usageId}
                            disabled={usage.length > 0}
                            title={usage.length ? "Remove or move the supports and loads that use it first." : undefined}
                            onClick={() => remove(selection.id, selection.name)}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">None yet. Saved selections can be reused by several supports and loads.</p>
          )}
          <p className="visually-hidden" role="status" aria-live="polite">{notice}</p>
        </div>
        <footer className="workflow-modal-footer">
          <button className="secondary" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
