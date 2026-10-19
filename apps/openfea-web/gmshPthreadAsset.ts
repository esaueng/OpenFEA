import type { PluginOption } from "vite";

// Emscripten starts its pthreads by importing this same module. Keep that
// worker entry as an untouched asset: Vite cannot statically infer the
// upstream workerOptions variable. The asset receives the already-compiled
// shared WASM module from Emscripten; it does not fetch a second binary.
export function gmshPthreadAsset(): PluginOption {
  return {
    name: "openfea:gmsh-pthread-asset",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@loumalouomega/gmsh-wasm/dist/gmsh-core.mjs")) return null;
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
