// Self-contained runner for scripts/verify-wasm-mesh-browser.mjs: serves the
// browser-proof build with `vite preview`, starts headless Chrome, and runs
// the bracket, STEP and mesh-then-solve proofs against it in turn.
//
// Usage (Node >= 22, Chrome installed):
//   VITE_BROWSER_PROOF=1 pnpm --filter @openfea/web build
//   node scripts/run-wasm-mesh-browser.mjs
// Env: PORT (5196), CDP_PORT (9333), CHROME_BIN, PROOFS (bracket,step,run),
// PROOF_TIMEOUT_MS (passed through; 180000 per proof).
// Exit code: the first failing proof's code (1 gate failed, 2 timeout), else 0.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5196);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);
const PROOFS = (process.env.PROOFS ?? "bracket,step,run").split(",").map((proof) => proof.trim()).filter(Boolean);
const QUERY = { bracket: "1", step: "step", run: "run" };
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profileDir = mkdtempSync(join(tmpdir(), "openfea-meshproof-"));
const children = [];

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(macChrome)) return macChrome;
  for (const candidate of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const resolved = spawnSync("which", [candidate], { encoding: "utf8" });
    if (resolved.status === 0 && resolved.stdout.trim()) return resolved.stdout.trim();
  }
  throw new Error("Chrome was not found. Set CHROME_BIN to a Chrome or Chromium executable.");
}

// detached => own process group, so the pnpm wrapper and the real server die together.
function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(2));

async function waitFor(label, probe, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probe().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

for (const proof of PROOFS) {
  if (!QUERY[proof]) throw new Error(`Unknown proof "${proof}"; expected one of ${Object.keys(QUERY).join(", ")}.`);
}

spawnChild("pnpm", ["--filter", "@openfea/web", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: repoRoot });
await waitFor("vite preview", async () => (await fetch(`http://127.0.0.1:${PORT}/`)).ok);
spawnChild(chromeBinary(), [
  "--headless=new",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "about:blank"
]);

for (const proof of PROOFS) {
  console.log(`[meshproof] ${proof}`);
  const { status } = spawnSync(process.execPath, [join(repoRoot, "scripts/verify-wasm-mesh-browser.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PROOF: proof, CDP_PORT: String(CDP_PORT), PAGE_URL: `http://127.0.0.1:${PORT}/?meshProof=${QUERY[proof]}` }
  });
  if (status !== 0) {
    console.error(`[meshproof] ${proof} failed with exit code ${status}`);
    process.exit(status ?? 1);
  }
}
console.log(`[meshproof] OK: ${PROOFS.join(", ")}`);
process.exit(0);
