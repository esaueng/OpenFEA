import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the meshing opt-out build excludes the threaded Gmsh runtime from nested workers", { timeout: 60_000 }, () => {
  const outDir = mkdtempSync(join(tmpdir(), "openfea-optout-build-"));
  try {
    const built = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", outDir], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: { ...process.env, VITE_WASM_MESHING: "0" },
      encoding: "utf8",
      timeout: 55_000,
      maxBuffer: 8 * 1024 * 1024
    });
    expect(built.status, `${built.error ?? ""}\n${built.stderr}\n${built.stdout}`.slice(-6000)).toBe(0);
    const assets = readdirSync(join(outDir, "assets"));
    expect(assets.filter((file) => /^gmsh-core|^gmsh-wasm\.json|^gmsh-[\w-]+\.js$/.test(file))).toEqual([]);
    expect(assets.some((file) => file.startsWith("occt-import-js") && file.endsWith(".wasm"))).toBe(true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
