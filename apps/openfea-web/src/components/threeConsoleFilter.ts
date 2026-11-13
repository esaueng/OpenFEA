import { setConsoleFunction } from "three";

/**
 * three r183 deprecated THREE.Clock in favour of THREE.Timer and warns from its
 * constructor. OpenFEA code does not use Clock (frame timing reads
 * performance.now()), but @react-three/fiber 9.8.2 — the latest stable
 * release — still creates `new THREE.Clock()` in every Canvas root store, so
 * each viewer mount logged the deprecation. Drop exactly that message; every
 * other three.js log, warning and error passes through unchanged. Remove this
 * once fiber's store stops constructing a Clock.
 */
export const FIBER_CLOCK_DEPRECATION_WARNING = "THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.";

let installed = false;

export function installThreeConsoleFilter(): void {
  if (installed) return;
  installed = true;
  // OpenFEA sets no other three.js console function, so this one forwards to the console.
  setConsoleFunction((type, message, ...params) => {
    // Clock's constructor deprecation is the only message three logs for Clock.
    if (!message.startsWith("THREE.Clock:")) console[type](message, ...params);
  });
}
