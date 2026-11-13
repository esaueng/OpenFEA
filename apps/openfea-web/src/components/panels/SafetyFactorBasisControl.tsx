import { useEffect, useState } from "react";

import type { SafetyFactorBasis, SafetyFactorStrength } from "@openfea/schema";

import type { ResolvedSafetyFactorBasis } from "../../safetyFactorBasis";
import { projectStressUnit, stressPascalsFromProjectUnits, stressPascalsToProjectUnits, type UnitSystem } from "../../unitDisplay";
import { Collapsible } from "./PanelChrome";

/**
 * Safety-factor basis (plan 036 R3.4): yield (default), ultimate, or a user
 * allowable stress typed in the project stress unit. The choice is stored on
 * the study and re-bases the stored result; it never re-runs the solve.
 */
export function SafetyFactorBasisControl({ basis, unitSystem, onChange }: {
  basis: ResolvedSafetyFactorBasis;
  unitSystem: UnitSystem;
  onChange?: (basis: SafetyFactorBasis) => void;
}) {
  const stored = basis.stored;
  const unit = projectStressUnit(unitSystem);
  const [draftStrength, setDraftStrength] = useState<SafetyFactorStrength>(stored.strength);
  const [draftAllowable, setDraftAllowable] = useState(() => allowableDraftText(stored.allowableStress, unitSystem));
  useEffect(() => {
    setDraftStrength(stored.strength);
    setDraftAllowable(allowableDraftText(stored.allowableStress, unitSystem));
  }, [stored.strength, stored.allowableStress, unitSystem]);

  const parsedAllowable = draftAllowable.trim() ? Number(draftAllowable) : Number.NaN;
  const allowableValid = Number.isFinite(parsedAllowable) && parsedAllowable > 0;
  const unavailable = basis.options.filter((option) => !option.available && option.reason);

  function selectStrength(strength: SafetyFactorStrength) {
    setDraftStrength(strength);
    if (!onChange) return;
    if (strength !== "allowable") {
      onChange({ strength, ...(stored.allowableStress ? { allowableStress: stored.allowableStress } : {}) });
      return;
    }
    // Allowable needs a value: reuse the stored one, else wait for the input.
    if (stored.allowableStress) onChange({ strength, allowableStress: stored.allowableStress });
  }

  function commitAllowable() {
    if (!onChange || draftStrength !== "allowable" || !allowableValid) return;
    const allowableStress = stressPascalsFromProjectUnits(parsedAllowable, unitSystem);
    if (stored.strength === "allowable" && stored.allowableStress === allowableStress) return;
    onChange({ strength: "allowable", allowableStress });
  }

  return (
    <Collapsible title="Safety factor basis" subtitle={basis.description} helpId="safetyFactorBasis">
      <label className="field">
        <span>Divide by</span>
        <select
          aria-label="Safety factor basis"
          value={draftStrength}
          disabled={!onChange}
          onChange={(event) => selectStrength(event.currentTarget.value as SafetyFactorStrength)}
        >
          {basis.options.map((option) => (
            <option key={option.strength} value={option.strength} disabled={!option.available}>
              {option.available ? option.label : `${option.label} (unavailable)`}
            </option>
          ))}
        </select>
      </label>
      {draftStrength === "allowable" && (
        <label className="field">
          <span>Allowable stress</span>
          <span className="input-with-unit">
            <input
              aria-label="Allowable stress"
              type="number"
              min="0"
              step="any"
              value={draftAllowable}
              onChange={(event) => setDraftAllowable(event.currentTarget.value)}
              onBlur={commitAllowable}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitAllowable();
              }}
            />
            <span>{unit}</span>
          </span>
        </label>
      )}
      {draftStrength === "allowable" && !allowableValid && <p className="panel-warning" role="alert">Enter a positive allowable stress in {unit}.</p>}
      {basis.fallbackReason && <p className="panel-warning" role="status">{basis.fallbackReason}</p>}
      {unavailable.map((option) => (
        <small key={option.strength} className="safety-basis-unavailable">{`${option.label}: ${option.reason}`}</small>
      ))}
      <p className="muted">Re-scales the stored safety factor from the solved von Mises stress. The solve and the stress results do not change.</p>
    </Collapsible>
  );
}

function allowableDraftText(allowablePa: number | undefined, unitSystem: UnitSystem): string {
  if (!(typeof allowablePa === "number" && Number.isFinite(allowablePa) && allowablePa > 0)) return "";
  // Plain digits for the number input (no locale grouping); six significant figures
  // keep a typed 36 ksi from echoing back as 35.9999999.
  return String(Number(stressPascalsToProjectUnits(allowablePa, unitSystem).toPrecision(6)));
}
