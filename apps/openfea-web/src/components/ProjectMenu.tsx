import { useState } from "react";
import { Moon, Settings2, Sun, X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { GITHUB_URL, KofiLink } from "./KofiLink";
import type { UnitSystem } from "../unitDisplay";
import type { ThemeMode } from "../workspaceViewTypes";

interface ProjectMenuProps {
  themeMode: ThemeMode;
  unitSystem: UnitSystem;
  onThemeModeChange: (mode: ThemeMode) => void;
  onUnitSystemChange: (unitSystem: UnitSystem) => void;
  /** Called when the menu opens, so the bar can close its other popovers. */
  onOpen?: () => void;
}

/**
 * Appearance, units and project links. Theme and units lived in the workflow rail's footer;
 * when the rail became a top-bar stepper (plan 035, increment 1) they moved here so they stay
 * one click away. The Ko-fi and GitHub links left the status bar in increment 6.
 */
export function ProjectMenu({ themeMode, unitSystem, onThemeModeChange, onUnitSystemChange, onOpen }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useFocusTrap<HTMLDivElement>(open, () => setOpen(false));

  return (
    <>
      <button
        className="icon-button"
        type="button"
        aria-expanded={open}
        aria-controls="workspace-project-menu"
        title="Project"
        aria-label="Project"
        onClick={() => { if (!open) onOpen?.(); setOpen((value) => !value); }}
      >
        <Settings2 size={17} aria-hidden="true" />
      </button>
      {open ? (
        <>
          <div className="shortcut-popover-backdrop" aria-hidden="true" onMouseDown={() => setOpen(false)} />
          <div ref={popoverRef} className="project-menu-popover" id="workspace-project-menu" role="dialog" aria-modal="true" aria-label="Project">
            <div className="project-menu-header">
              <strong>Project</strong>
              <button className="shortcut-popover-close" type="button" aria-label="Close project menu" onClick={() => setOpen(false)}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="project-menu-row">
              <span id="project-menu-theme">Theme</span>
              <div className="segmented" role="radiogroup" aria-labelledby="project-menu-theme">
                <button type="button" role="radio" aria-checked={themeMode === "dark"} className={themeMode === "dark" ? "active" : ""} onClick={() => onThemeModeChange("dark")}>
                  <Moon size={14} aria-hidden="true" />Dark
                </button>
                <button type="button" role="radio" aria-checked={themeMode === "light"} className={themeMode === "light" ? "active" : ""} onClick={() => onThemeModeChange("light")}>
                  <Sun size={14} aria-hidden="true" />Light
                </button>
              </div>
            </div>
            <div className="project-menu-row">
              <span id="project-menu-units">Units</span>
              <div className="segmented" role="radiogroup" aria-labelledby="project-menu-units">
                <button type="button" role="radio" aria-checked={unitSystem === "SI"} className={unitSystem === "SI" ? "active" : ""} onClick={() => onUnitSystemChange("SI")}>
                  Metric (mm)
                </button>
                <button type="button" role="radio" aria-checked={unitSystem === "US"} className={unitSystem === "US" ? "active" : ""} onClick={() => onUnitSystemChange("US")}>
                  Imperial (in)
                </button>
              </div>
            </div>
            <ProjectMenuLinks />
          </div>
        </>
      ) : null}
    </>
  );
}

/** Support and source links, under Theme and Units. */
export function ProjectMenuLinks() {
  return (
    <div className="project-menu-links">
      <KofiLink />
      <a className="project-menu-github" href={GITHUB_URL} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </div>
  );
}
