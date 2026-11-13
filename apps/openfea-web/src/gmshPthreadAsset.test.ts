import type { Plugin } from "vite";
import { describe, expect, test } from "vitest";
import { gmshPthreadAsset, isGmshPthreadEntry } from "../gmshPthreadAsset";

const ENTRY = "/repo/node_modules/.pnpm/@loumalouomega+gmsh-wasm@0.4.0/node_modules/@loumalouomega/gmsh-wasm/dist/gmsh-core.mjs";
const UPSTREAM = 'a;worker=new Worker(new URL("gmsh-core.mjs",import.meta.url),workerOptions);b';

function transform(code: string, id: string) {
  const plugin = gmshPthreadAsset() as Plugin;
  const hook = plugin.transform as (this: unknown, code: string, id: string) => { code: string } | null;
  return hook.call({}, code, id);
}

describe("gmsh pthread asset plugin", () => {
  test("rewrites the pthread worker URL for build ids and dev ids with a version query", () => {
    // `pnpm dev` serves node_modules modules as gmsh-core.mjs?v=<hash>; missing
    // that left the upstream non-static workerOptions for
    // vite:worker-import-meta-url, which failed every dev mesh.
    for (const id of [ENTRY, `${ENTRY}?v=a562feab`, `${ENTRY}?import&v=1`, ENTRY.replaceAll("/", "\\")]) {
      expect(isGmshPthreadEntry(id)).toBe(true);
      const result = transform(UPSTREAM, id);
      expect(result?.code).toContain('import openfeaPthreadUrl from "./gmsh-core.mjs?url";');
      expect(result?.code).toContain("new Worker(new URL(openfeaPthreadUrl,import.meta.url),workerOptions)");
      expect(result?.code).not.toContain('new URL("gmsh-core.mjs",import.meta.url)');
    }
  });

  test("leaves asset-style imports of the same file and other modules alone", () => {
    for (const id of [`${ENTRY}?url`, `${ENTRY}?v=1&url`, `${ENTRY}?raw`, `${ENTRY}?worker`, "/repo/src/workers/meshWorker.ts"]) {
      expect(isGmshPthreadEntry(id)).toBe(false);
      expect(transform('export default "/x/gmsh-core.mjs"', id)).toBeNull();
    }
  });

  test("fails loudly if the upstream pthread entry changes shape", () => {
    expect(() => transform("worker=new Worker(url,opts)", ENTRY)).toThrow(/Gmsh pthread entry changed/);
  });
});
