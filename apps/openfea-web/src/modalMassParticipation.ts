import type { ModalMassParticipation } from "@openfea/schema";
import { solverMassToKilograms } from "@openfea/units";

export const MODAL_DIRECTIONS = ["X", "Y", "Z"] as const;

export const PROJECTED_PARTICIPATION_NOTE = "Mass participation is computed on the projected linear Tet4 model used for the frequency solve.";

export function formatMassPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatMassKg(value: number, units: ModalMassParticipation["massUnits"]): string {
  return `${Number(solverMassToKilograms(value, units).toPrecision(4))} kg`;
}

export function formatMassTripleKg(values: readonly number[], units: ModalMassParticipation["massUnits"]): string {
  return values.map((value) => formatMassKg(value, units)).join(" / ");
}

export function cumulativeParticipation(participation: ModalMassParticipation): [number, number, number] {
  return participation.modes.at(-1)?.cumulativeEffectiveMassRatio ?? [0, 0, 0];
}
