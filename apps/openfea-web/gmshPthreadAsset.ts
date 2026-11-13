import type { PluginOption } from "vite";

// Emscripten starts its pthreads by importing this same module. Keep that
// worker entry as an untouched asset: Vite cannot statically infer the
// upstream workerOptions variable. The asset receives the already-compiled
// shared WASM module from Emscripten; it does not fetch a second binary.
//
// The dev server serves node_modules files with a version query
// (gmsh-core.mjs?v=<hash>), so match on the path without its query; otherwise
// vite:worker-import-meta-url rejects the upstream non-static workerOptions and
// every dev mesh fails. Asset-style imports of the same file (the ?url this
// plugin adds, ?raw, ?worker) are not the module itself and stay untouched.
const MODULE_CACHE_QUERY_KEYS = new Set(["v", "t", "import"]);

export function isGmshPthreadEntry(id: string): boolean {
  const [path = "", query = ""] = id.split("?", 2);
  if (!path.replaceAll("\\", "/").endsWith("/@loumalouomega/gmsh-wasm/dist/gmsh-core.mjs")) return false;
  return [...new URLSearchParams(query).keys()].every((key) => MODULE_CACHE_QUERY_KEYS.has(key));
}

export function gmshPthreadAsset(): PluginOption {
  return {
    name: "openfea:gmsh-pthread-asset",
    enforce: "pre",
    transform(code, id) {
      if (!isGmshPthreadEntry(id)) return null;
      const original = 'new Worker(new URL("gmsh-core.mjs",import.meta.url),workerOptions)';
      if (code.split(original).length !== 2) {
        throw new Error("Gmsh pthread entry changed; review its browser packaging before upgrading.");
      }
      return {
        code: 'import openfeaPthreadUrl from "./gmsh-core.mjs?url";\n' + code.replace(
          original, 'new Worker(new URL(openfeaPthreadUrl,import.meta.url),workerOptions)'
        ),
        map: null
      };
    }
  };
}
