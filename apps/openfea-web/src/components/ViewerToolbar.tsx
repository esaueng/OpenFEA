import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Eye, Grid3x3, Maximize2, RotateCcw, Ruler, ScanLine, X } from "lucide-react";
import type { ProjectionMode, SectionPlaneState } from "../workspaceViewTypes";

export type CameraView = "x" | "y" | "z" | "iso";

interface ViewerToolbarProps {
  projectionMode: ProjectionMode;
  showDimensions: boolean;
  sectionPlane: SectionPlaneState;
  /** Null hides the mesh toggle (on Results the viewer owns its own view mode). */
  meshShown: boolean | null;
  onCameraView: (view: CameraView) => void;
  onProjectionModeChange?: (mode: ProjectionMode) => void;
  onFitView?: () => void;
  onToggleDimensions?: () => void;
  onToggleMesh?: () => void;
  onSectionPlaneChange?: (plane: SectionPlaneState) => void;
}

const CAMERA_VIEWS: ReadonlyArray<{ view: CameraView; label: string }> = [
  { view: "x", label: "X axis view" },
  { view: "y", label: "Y axis view" },
  { view: "z", label: "Z axis view" },
  { view: "iso", label: "Isometric view" }
];

/**
 * One floating toolbar for the viewer (plan 035, increment 3). It replaced the X/Y/Z/Iso
 * strip, the projection toggle and the Model panel's View buttons. The view cube is drawn
 * in the canvas and cannot take keyboard focus, so the Views menu here is the accessible
 * camera control: it follows the ARIA menu pattern (arrow keys, Home/End, Escape).
 */
export function ViewerToolbar(props: ViewerToolbarProps) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!viewsOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setViewsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [viewsOpen]);

  function closeMenu(refocus: boolean) {
    setViewsOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") { event.preventDefault(); focusAt(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusAt(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusAt(0); }
    else if (event.key === "End") { event.preventDefault(); focusAt(items.length - 1); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    else if (event.key === "Tab") { setViewsOpen(false); }
  }

  const section = props.sectionPlane;
  return (
    <>
      {section.enabled ? (
        <div className="viewer-section-card" role="group" aria-label="Section plane">
          <div className="viewer-section-row">
            <span>Section</span>
            <div className="segmented" role="group" aria-label="Section plane axis">
              {(["x", "y", "z"] as const).map((axis) => (
                <button
                  key={axis}
                  className={section.axis === axis ? "active" : ""}
                  type="button"
                  aria-pressed={section.axis === axis}
                  onClick={() => props.onSectionPlaneChange?.({ ...section, axis })}
                >{axis.toUpperCase()}</button>
              ))}
            </div>
            <button className="viewer-toolbar-icon" type="button" aria-pressed={section.flipped} title="Flip cut side" aria-label="Flip cut side" onClick={() => props.onSectionPlaneChange?.({ ...section, flipped: !section.flipped })}>
              <RotateCcw size={15} aria-hidden="true" />
            </button>
            <button className="viewer-toolbar-icon" type="button" title="Close section" aria-label="Close section" onClick={() => props.onSectionPlaneChange?.({ ...section, enabled: false })}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <label className="viewer-section-offset">
            <span>Offset · {Math.round(section.offset * 100)}%</span>
            <input type="range" min="0" max="1" step="0.01" value={section.offset} onChange={(event) => props.onSectionPlaneChange?.({ ...section, offset: Number(event.currentTarget.value) })} />
          </label>
        </div>
      ) : null}
      <div className="viewer-toolbar" role="toolbar" aria-label="View">
        <button type="button" onClick={props.onFitView} title="Fit the model in view">
          <Maximize2 size={15} aria-hidden="true" /><span className="viewer-toolbar-label">Fit</span>
        </button>
        <div className="viewer-toolbar-menu-anchor">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={viewsOpen}
            aria-controls="viewer-views-menu"
            onClick={() => setViewsOpen((open) => !open)}
          >
            <Eye size={15} aria-hidden="true" /><span className="viewer-toolbar-label">Views</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          {viewsOpen ? (
            <div ref={menuRef} className="viewer-views-menu" id="viewer-views-menu" role="menu" aria-label="Camera views" onKeyDown={handleMenuKeyDown}>
              {CAMERA_VIEWS.map((item) => (
                <button key={item.view} type="button" role="menuitem" tabIndex={-1} onClick={() => { props.onCameraView(item.view); closeMenu(true); }}>
                  {item.label}
                </button>
              ))}
              <div className="viewer-views-separator" role="separator" />
              {(["perspective", "orthographic"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={props.projectionMode === mode}
                  onClick={() => { props.onProjectionModeChange?.(mode); closeMenu(true); }}
                >
                  {mode === "perspective" ? "Perspective" : "Orthographic"}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" aria-pressed={section.enabled} onClick={() => props.onSectionPlaneChange?.({ ...section, enabled: !section.enabled })}>
          <ScanLine size={15} aria-hidden="true" /><span className="viewer-toolbar-label">Section</span>
        </button>
        {props.meshShown !== null ? (
          <button type="button" aria-pressed={props.meshShown} onClick={props.onToggleMesh}>
            <Grid3x3 size={15} aria-hidden="true" /><span className="viewer-toolbar-label">Mesh</span>
          </button>
        ) : null}
        <button type="button" aria-pressed={props.showDimensions} onClick={props.onToggleDimensions}>
          <Ruler size={15} aria-hidden="true" /><span className="viewer-toolbar-label">Dimensions</span>
        </button>
      </div>
    </>
  );
}
