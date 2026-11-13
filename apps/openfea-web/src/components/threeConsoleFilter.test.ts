import * as THREE from "three";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installThreeConsoleFilter } from "./threeConsoleFilter";

describe("three console filter", () => {
  afterEach(() => vi.restoreAllMocks());

  test("silences only fiber's THREE.Clock deprecation and passes other three.js warnings through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installThreeConsoleFilter();
    installThreeConsoleFilter(); // idempotent

    // @react-three/fiber's root store still constructs one per Canvas mount.
    new THREE.Clock();
    expect(warn).not.toHaveBeenCalled();

    THREE.warn("WebGLRenderer: something real.", 42);
    expect(warn).toHaveBeenCalledWith("THREE.WebGLRenderer: something real.", 42);
  });

  test("OpenFEA viewer code no longer reads fiber's Clock for frame timing", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "CadViewer.tsx"), "utf8");
    expect(source).not.toMatch(/\bclock\.(elapsedTime|getDelta|getElapsedTime)\b/);
    expect(source).not.toMatch(/new THREE\.Clock\(/);
  });
});
