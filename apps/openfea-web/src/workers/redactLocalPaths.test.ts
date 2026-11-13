import { describe, expect, test } from "vitest";
import { redactLocalPaths } from "./redactLocalPaths";

describe("redactLocalPaths", () => {
  test("reduces dev-server, file and absolute paths to file names", () => {
    expect(redactLocalPaths("[vite] /@fs/home/alice/OpenFEA/node_modules/x/dist/gmsh-core.mjs?v=1 failed")).toBe("[vite] gmsh-core.mjs failed");
    expect(redactLocalPaths("Cannot load file:///Users/bob/OpenFEA/node_modules/a/b.wasm")).toBe("Cannot load b.wasm");
    expect(redactLocalPaths("Error at http://localhost:5173/src/workers/meshWorker.ts:12:3")).toBe("Error at meshWorker.ts:12:3");
    expect(redactLocalPaths("ENOENT: open 'C:\\Users\\carol\\OpenFEA\\gmsh-core.wasm'")).toBe("ENOENT: open 'gmsh-core.wasm'");
    expect(redactLocalPaths("File: /home/alice/OpenFEA/apps/openfea-web/src/x.ts:9")).toBe("File: x.ts:9");
  });

  test("leaves ordinary mesh messages, units and public URLs alone", () => {
    for (const message of [
      "Mesh quality gate failed: 3 inverted elements.",
      "Load 250 N/mm over 2 faces; 12 W/m² flux.",
      "See https://openfea.app/docs/meshing for help.",
      "Ratio 1/2 at face 4"
    ]) {
      expect(redactLocalPaths(message)).toBe(message);
    }
  });
});
