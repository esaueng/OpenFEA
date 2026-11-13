import type { Constraint } from "./index";

/** Global displacement components a support can constrain. */
export const SUPPORT_COMPONENTS = ["x", "y", "z"] as const;
export type SupportComponent = (typeof SUPPORT_COMPONENTS)[number];

/** An elastic support's normal and tangential foundation moduli in N/m^3 (0 when absent or invalid). */
export function elasticSupportStiffness(constraint: Pick<Constraint, "type" | "parameters">): { normal: number; tangential: number } {
  if (constraint.type !== "elastic_support") return { normal: 0, tangential: 0 };
  const read = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return { normal: read(constraint.parameters.normalStiffness), tangential: read(constraint.parameters.tangentialStiffness) };
}

/**
 * Global components a fixed support holds. A fixed support without
 * `parameters.components` (every project saved before plan 036 R1.4) holds
 * all three. Returns components in x, y, z order.
 */
export function fixedSupportComponents(constraint: Pick<Constraint, "type" | "parameters">): SupportComponent[] {
  if (constraint.type !== "fixed") return [];
  const components = constraint.parameters.components;
  if (!Array.isArray(components) || components.length === 0) return [...SUPPORT_COMPONENTS];
  return SUPPORT_COMPONENTS.filter((component) => components.includes(component));
}
