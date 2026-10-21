// Solve-ladder benchmark driver (plan 036 R5.1; plan 024 Release 4 measurement).
// Manual, not CI — see docs/validation/solve-ladder.md for why.
//
// Drives the ?solveLadder=1 harness (apps/openfea-web/src/workers/solveLadderHarness.ts)
// through deterministic structured fixtures at ~30k / ~75k / <=150k total DOF,
// block (well-conditioned) and slender (ill-conditioned) variants, Tet4 and
// Tet10 static, plus modal + dynamic at 30k. Every case runs in a FRESH browser
// process so the kernel peak-RSS reading belongs to that case alone.
//
// Per case it records assembly / CG / recovery time, CG iterations,
// preconditioner, true final relative residual, memory (each value labeled with
// the method that produced it) and parity against the Node reference
// (docs/validation/solve-ladder/reference-node.json, produced by
// scripts/solve-ladder-node.ts) within LADDER_PARITY_REL_TOL.
//
// Usage:
//   VITE_BROWSER_PROOF=1 pnpm --filter @openfea/web build
//   pnpm verify:solve-ladder [--rungs=30k,75k] [--cases=block-tet4-30k-static,...] [--engines=chromium,webkit]
// Env: CHROME_BIN, PORT (5201), CDP_PORT (9338), LADDER_CASE_TIMEOUT_MS (2700000), LADDER_HEAP_POLL_MS (250; 0 = off),
//      LADDER_OUT (results JSON path; default docs/validation/solve-ladder/<date>-<engine>.json),
//      PLAYWRIGHT_WEBKIT_DIR (scratch dir holding playwright-webkit; never a repo dependency).
// Exit codes: 0 every executed case passed its gates, 1 a case failed or a gate tripped.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5201);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9338);
const CASE_TIMEOUT_MS = Number(process.env.LADDER_CASE_TIMEOUT_MS ?? 45 * 60_000);
/** Worker heap poll interval; 0 disables polling (timing-only runs). */
const HEAP_POLL_MS = Number(process.env.LADDER_HEAP_POLL_MS ?? 250);
/** Same-code parity: browser vs Node V8 reference on displacement, reaction, frequencies. */
const LADDER_PARITY_REL_TOL = 1e-6;
/** Equilibrium: clamp reaction must cancel the applied tip load. */
const LADDER_REACTION_BALANCE_REL_TOL = 1e-6;
/** Slender Tet10 tip deflection vs Timoshenko beam theory (L/H = 50; clamp end effects < 1%). */
const LADDER_BEAM_THEORY_REL_TOL = 0.01;
/** Memory budget, matching scripts/verify-100k-solve.mjs stop lines. */
const MEMORY_BUDGET_HEAP_BYTES = 1.5e9;
const MEMORY_BUDGET_PROCESS_BYTES = 2e9;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "apps/openfea-web/dist");
const referencePath = join(repoRoot, "docs/validation/solve-ladder/reference-node.json");
const argument = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3).split(",").filter(Boolean);

// Mirrors ladderCases() in apps/openfea-web/src/workers/solveLadderFixtures.ts.
const RUNGS = ["30k", "75k", "150k"];
const ALL_CASES = RUNGS.flatMap((rung) =>
  ["block", "slender"].flatMap((shape) =>
    ["tet4", "tet10"].flatMap((order) =>
      (rung === "30k" ? ["static", "modal", "dynamic"] : ["static"]).map((analysis) => ({
        id: `${shape}-${order}-${rung}-${analysis}`,
        shape,
        order,
        rung,
        analysis
      }))
    )
  )
);
/** Timoshenko tip deflection for the slender fixture (mm); see ladderTimoshenkoTipDeflection(). */
function slenderTimoshenkoTipDeflection() {
  const [length, width, height, force, e, nu] = [1000, 20, 20, 100, 200_000, 0.3];
  const inertia = (width * height ** 3) / 12;
  const shearModulus = e / (2 * (1 + nu));
  const kappa = (10 * (1 + nu)) / (12 + 11 * nu);
  return (force * length ** 3) / (3 * e * inertia) + (force * length) / (kappa * shearModulus * width * height);
}

// ── Process helpers ─────────────────────────────────────────────────────────
const children = [];
function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "ignore", detached: true, ...options });
  children.push(child);
  return child;
}
function killChild(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
process.on("exit", () => {
  for (const child of children) killChild(child);
});
process.on("SIGINT", () => process.exit(2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const candidate of ["/opt/pw-browsers/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const resolved = spawnSync("which", [candidate], { encoding: "utf8" });
    if (resolved.status === 0 && resolved.stdout.trim()) return resolved.stdout.trim();
  }
  throw new Error("Chromium was not found. Set CHROME_BIN.");
}

/** Descendant pids of rootPid (inclusive of nothing else) via ps. */
function descendants(rootPid) {
  const listed = spawnSync("ps", ["axo", "pid=,ppid=,rss="], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  const byParent = new Map();
  const rss = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [pid, ppid, rssKb] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid)) continue;
    rss.set(pid, rssKb * 1024);
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const child of byParent.get(queue.pop()) ?? []) {
      found.push({ pid: child, rssBytes: rss.get(child) ?? 0 });
      queue.push(child);
    }
  }
  return found;
}

/** Linux kernel lifetime peak RSS (VmHWM) of a live process, bytes. */
function vmHwmBytes(pid) {
  try {
    const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmHWM:\s+(\d+)\s+kB/);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function processRole(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.match(/--type=([\w-]+)/)?.[1] ?? cmdline.split("\0")[0].split("/").pop();
  } catch {
    return undefined;
  }
}

/** Polls the browser's process tree; returns the largest process peak at stop(). */
function processMemoryTracker(rootPid) {
  let peakRss = { pid: undefined, bytes: 0 };
  const poll = () => {
    for (const entry of descendants(rootPid)) {
      if (entry.rssBytes > peakRss.bytes) peakRss = { pid: entry.pid, bytes: entry.rssBytes };
    }
  };
  const timer = setInterval(poll, 500);
  return {
    stop() {
      clearInterval(timer);
      poll();
      let hwm = { pid: undefined, bytes: 0 };
      for (const entry of descendants(rootPid)) {
        const bytes = vmHwmBytes(entry.pid);
        if (bytes !== undefined && bytes > hwm.bytes) hwm = { pid: entry.pid, bytes };
      }
      return hwm.bytes > 0
        ? { method: "largest child process VmHWM (Linux kernel peak RSS)", peakBytes: hwm.bytes, role: processRole(hwm.pid) }
        : { method: "largest child process RSS (ps, polled 500 ms)", peakBytes: peakRss.bytes, role: processRole(peakRss.pid) };
    }
  };
}

// ── Static server: dist with COOP/COEP so measureUserAgentSpecificMemory is exposed ──
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".gz": "application/gzip"
};
function startStaticServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
    let path = normalize(join(distDir, decodeURIComponent(url.pathname)));
    if (!path.startsWith(distDir)) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(distDir, "index.html");
    response.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "no-store"
    });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// ── Chromium leg (CDP, fresh browser per case) ──────────────────────────────
/** Minimal flattened-session CDP client (scripts/browser-cdp.mjs has no sessionId support). */
async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      for (const handler of handlers.get(message.method) ?? []) handler(message.params, message.sessionId);
    }
  };
  socket.onclose = () => {
    for (const resolve of pending.values()) resolve({ error: { message: "DevTools socket closed" } });
    pending.clear();
  };
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `DevTools timed out: ${method}` } });
        }, 30_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method, handler) {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
    },
    close() {
      socket.close();
    }
  };
}

/**
 * Polls Runtime.getHeapUsage on every attached worker target every HEAP_POLL_MS. Chromium answers
 * it via a V8 interrupt, so it samples even while the worker thread is inside
 * the synchronous solve. backingStorageSize covers ArrayBuffer stores (the CSR
 * matrix and CG vectors), which performance.memory never includes.
 */
function workerHeapTracker(cdp) {
  const sessions = new Set();
  let peak = { usedSize: 0, backingStorageSize: 0, totalBytes: 0 };
  let samples = 0;
  cdp.on("Target.attachedToTarget", (params) => {
    if (params.targetInfo?.type === "worker") sessions.add(params.sessionId);
  });
  let polling = false;
  const timer = HEAP_POLL_MS > 0 && setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      for (const sessionId of sessions) {
        const response = await cdp.send("Runtime.getHeapUsage", {}, sessionId);
        const usage = response.result;
        if (!usage) continue;
        samples += 1;
        const totalBytes = (usage.usedSize ?? 0) + (usage.backingStorageSize ?? 0);
        if (totalBytes > peak.totalBytes) peak = { usedSize: usage.usedSize ?? 0, backingStorageSize: usage.backingStorageSize ?? 0, totalBytes };
      }
    } finally {
      polling = false;
    }
  }, HEAP_POLL_MS);
  return {
    stop() {
      if (timer) clearInterval(timer);
      return samples
        ? {
            method: `CDP Runtime.getHeapUsage on the worker target (usedSize + backingStorageSize, polled ${HEAP_POLL_MS} ms)`,
            peakBytes: peak.totalBytes,
            peakHeapUsedBytes: peak.usedSize,
            peakArrayBufferBytes: peak.backingStorageSize,
            samples
          }
        : { method: "unavailable (no worker heap samples)", samples };
    }
  };
}

async function runChromiumCase(entry) {
  const profileDir = mkdtempSync(join(tmpdir(), "openfea-solve-ladder-"));
  const chrome = spawnChild(chromeBinary(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    // Precise (non-bucketed) performance.memory values.
    "--enable-precise-memory-info",
    // Chromium refuses to start as root (cloud containers) with its sandbox on.
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "about:blank"
  ]);
  const memory = processMemoryTracker(chrome.pid);
  let processMemory;
  let workerHeap;
  let cdp;
  try {
    const browserTarget = await waitFor("Chromium DevTools endpoint", async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(), 30_000, 250);
    cdp = await connectCdp(browserTarget.webSocketDebuggerUrl);
    const heapTracker = workerHeapTracker(cdp);
    const pageTarget = (await cdp.send("Target.getTargets")).result.targetInfos.find((info) => info.type === "page");
    const pageSession = (await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true })).result.sessionId;
    cdp.on("Runtime.exceptionThrown", (params) => console.log(`[chromium pageerror] ${JSON.stringify(params.exceptionDetails).slice(0, 300)}`));
    await cdp.send("Runtime.enable", {}, pageSession);
    // Attach (flattened) to the page's dedicated workers as they spawn.
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);
    const version = (await cdp.send("Browser.getVersion")).result;
    await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/?solveLadder=1&case=${entry.id}` }, pageSession);
    const page = await waitFor(`${entry.id} result`, async () => {
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: "window.__openfeaSolveLadder && window.__openfeaSolveLadder.lastResult ? JSON.stringify(window.__openfeaSolveLadder.lastResult) : null",
        returnByValue: true
      }, pageSession);
      const value = evaluated.result?.result?.value;
      return typeof value === "string" ? JSON.parse(value) : null;
    }, CASE_TIMEOUT_MS, 2000);
    workerHeap = heapTracker.stop();
    processMemory = memory.stop();
    return { engine: "chromium", browserVersion: version?.product, ...page, processMemory, workerHeap };
  } catch (error) {
    processMemory ??= memory.stop();
    return {
      engine: "chromium",
      result: { ok: false, caseId: entry.id, analysis: entry.analysis, error: error?.message ?? String(error) },
      processMemory
    };
  } finally {
    cdp?.close();
    killChild(chrome);
    await sleep(500);
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// ── WebKit leg (Playwright from a scratch dir, never repo deps) ─────────────
const WEBKIT_RUNNER_SOURCE = `import { webkit } from "playwright-webkit";
const browser = await webkit.launch();
const page = await browser.newPage();
page.on("pageerror", (error) => console.error("[webkit pageerror] " + String(error).slice(0, 300)));
await page.goto(process.env.LADDER_URL);
const started = Date.now();
let result = null;
while (Date.now() - started < Number(process.env.LADDER_TIMEOUT_MS)) {
  result = await page.evaluate(() => window.__openfeaSolveLadder && window.__openfeaSolveLadder.lastResult ? JSON.stringify(window.__openfeaSolveLadder.lastResult) : null);
  if (result) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log("LADDER_PID " + (browser.process?.()?.pid ?? ""));
await browser.close();
console.log(result ? "LADDER_JSON " + result : "LADDER_TIMEOUT");
`;

function webkitAvailability() {
  const dir = process.env.PLAYWRIGHT_WEBKIT_DIR;
  if (!dir || !existsSync(join(dir, "node_modules", "playwright-webkit"))) {
    return { ok: false, reason: "PLAYWRIGHT_WEBKIT_DIR does not point at a scratch dir with playwright-webkit installed" };
  }
  const probe = spawnSync("node", ["--input-type=module", "-e", "import { webkit } from 'playwright-webkit'; const b = await webkit.launch(); await b.close();"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000
  });
  return probe.status === 0 ? { ok: true, dir } : { ok: false, reason: `WebKit failed to launch: ${(probe.stderr || probe.stdout).split("\n")[0]}` };
}

async function runWebkitCase(entry, dir) {
  const runnerPath = join(dir, "openfea-solve-ladder-webkit-runner.mjs");
  writeFileSync(runnerPath, WEBKIT_RUNNER_SOURCE);
  return await new Promise((resolve) => {
    const child = spawn("node", [runnerPath], {
      cwd: dir,
      env: { ...process.env, LADDER_URL: `http://localhost:${PORT}/?solveLadder=1&case=${entry.id}`, LADDER_TIMEOUT_MS: String(CASE_TIMEOUT_MS) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    children.push(child);
    const memory = processMemoryTracker(child.pid);
    let stdout = "";
    let processMemory;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // Read the kernel peak before the browser closes.
      if (!processMemory && stdout.includes("LADDER_PID ")) processMemory = memory.stop();
    });
    child.stderr.on("data", (chunk) => process.stdout.write(String(chunk)));
    child.on("exit", () => {
      processMemory ??= memory.stop();
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("LADDER_JSON "));
      resolve(line
        ? { engine: "webkit", ...JSON.parse(line.slice("LADDER_JSON ".length)), processMemory }
        : { engine: "webkit", result: { ok: false, caseId: entry.id, analysis: entry.analysis, error: stdout.includes("LADDER_TIMEOUT") ? "timeout" : `runner failed: ${stdout.slice(0, 300)}` }, processMemory });
    });
  });
}

// ── Gates ───────────────────────────────────────────────────────────────────
function relativeDelta(left, right) {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale > 0 ? Math.abs(left - right) / scale : 0;
}

function evaluate(run, reference) {
  const result = run.result;
  const checks = [];
  if (!result.ok) return { passed: false, checks: [`solve failed: ${result.code ?? ""} ${result.error.split("\n")[0]}`] };
  if (!result.coreResultValid) checks.push("FAIL Core result validation");
  const ref = reference?.cases?.[result.caseId];
  const sameFixture = ref?.ok && ref.fixture?.fingerprint === result.fixture.fingerprint;
  if (!sameFixture) checks.push("FAIL no Node reference for this fixture fingerprint (run scripts/solve-ladder-node.ts)");
  const compare = (label, value, expected, tolerance) => {
    const delta = relativeDelta(value, expected);
    checks.push(`${delta <= tolerance ? "ok" : "FAIL"} ${label} rel ${delta.toExponential(2)} (tol ${tolerance})`);
  };
  if (result.analysis === "static") {
    const balance = result.parity.reactionBalanceRelError;
    checks.push(`${balance <= LADDER_REACTION_BALANCE_REL_TOL ? "ok" : "FAIL"} reaction balance ${balance.toExponential(2)} (tol ${LADDER_REACTION_BALANCE_REL_TOL})`);
    if (sameFixture) {
      compare("tip uz vs Node", result.parity.tipMeanUz, ref.parity.tipMeanUz, LADDER_PARITY_REL_TOL);
      compare("max |u| vs Node", result.parity.maxDisplacement, ref.parity.maxDisplacement, LADDER_PARITY_REL_TOL);
      compare("reaction vs Node", result.parity.reactionZ, ref.parity.reactionZ, LADDER_PARITY_REL_TOL);
    }
    if (result.fixture.shape === "slender" && result.fixture.order === "Tet10") {
      compare("tip uz vs Timoshenko", -result.parity.tipMeanUz, slenderTimoshenkoTipDeflection(), LADDER_BEAM_THEORY_REL_TOL);
    }
  } else if (result.analysis === "modal" && sameFixture) {
    result.solver.frequenciesHz.forEach((frequency, index) => compare(`f${index + 1} vs Node`, frequency, ref.solver.frequenciesHz[index], LADDER_PARITY_REL_TOL));
  } else if (result.analysis === "dynamic" && sameFixture) {
    compare("peak |u| vs Node", result.solver.peakDisplacement, ref.solver.peakDisplacement, LADDER_PARITY_REL_TOL);
  }
  const heapPeak = Math.max(result.heap.peakBytes ?? 0, run.workerHeap?.peakBytes ?? 0, run.uaMemory?.peakBytes ?? 0);
  if (heapPeak > MEMORY_BUDGET_HEAP_BYTES) checks.push(`FAIL JS heap ${mb(heapPeak)} over ${mb(MEMORY_BUDGET_HEAP_BYTES)} budget`);
  if ((run.processMemory?.peakBytes ?? 0) > MEMORY_BUDGET_PROCESS_BYTES) {
    checks.push(`FAIL process peak ${mb(run.processMemory.peakBytes)} over ${mb(MEMORY_BUDGET_PROCESS_BYTES)} budget`);
  }
  return { passed: !checks.some((check) => check.startsWith("FAIL")), checks };
}

const mb = (bytes) => (bytes === undefined || bytes === 0 ? "n/a" : `${Math.round(bytes / 1e6)} MB`);
const seconds = (ms) => (ms === undefined ? "–" : (ms / 1000).toFixed(1));

function tableRow(run) {
  const result = run.result;
  if (!result.ok) return `| ${result.caseId} | ${run.engine} | – | – | – | – | – | – | – | – | – | **FAIL**: ${result.error.split("\n")[0].slice(0, 80)} |`;
  const iterations = result.analysis === "dynamic"
    ? `${result.solver.cgIterationsTotal} (max ${result.solver.cgIterationsMaxPerStep}/step)`
    : result.analysis === "modal"
      ? `${result.solver.subspaceIterations} subspace`
      : String(result.solver.cgIterations);
  const residual = result.solver.finalRelativeResidual?.toExponential(1) ?? "–";
  const solveMs = result.analysis === "static" ? result.timings.solveMs : result.timings.totalSolveMs;
  return `| ${result.caseId} | ${run.engine} | ${result.fixture.totalDofs.toLocaleString("en-US")} / ${result.fixture.freeDofs.toLocaleString("en-US")} | ` +
    `${seconds(result.timings.assembleMs)} | ${seconds(solveMs)} | ${iterations} | ${result.settings.preconditioner.split(" ")[0]} | ${residual} | ` +
    `${mb(run.workerHeap?.peakBytes ?? result.heap.peakBytes)} | ${mb(run.uaMemory?.peakBytes)} | ${mb(run.processMemory?.peakBytes)} | ${run.evaluation.passed ? "pass" : "**FAIL**"} |`;
}

// ── Main ────────────────────────────────────────────────────────────────────
const rungFilter = argument("rungs");
const caseFilter = argument("cases");
const engines = argument("engines") ?? ["chromium", "webkit"];
const selected = ALL_CASES.filter((entry) => (!rungFilter || rungFilter.includes(entry.rung)) && (!caseFilter || caseFilter.includes(entry.id)));

if (!existsSync(join(distDir, "index.html"))) {
  console.error("apps/openfea-web/dist is missing; run `VITE_BROWSER_PROOF=1 pnpm --filter @openfea/web build` first.");
  process.exit(1);
}
if (!readdirSync(join(distDir, "assets")).some((file) => file.startsWith("solveLadderWorker"))) {
  console.error("dist has no solve-ladder worker chunk; rebuild with VITE_BROWSER_PROOF=1.");
  process.exit(1);
}
const reference = existsSync(referencePath) ? JSON.parse(readFileSync(referencePath, "utf8")) : undefined;
const server = await startStaticServer();
console.log(`[serve] dist with COOP/COEP on :${PORT}; ${selected.length} case(s); engines ${engines.join(", ")}`);

const machine = {
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalMemoryBytes: totalmem(),
  platform: `${process.platform}-${process.arch}`,
  kernel: release(),
  node: process.version
};
const date = new Date().toISOString().slice(0, 10);
let failed = false;
for (const engine of engines) {
  let webkitDir;
  if (engine === "webkit") {
    const available = webkitAvailability();
    if (!available.ok) {
      console.log(`[webkit] SKIPPED: ${available.reason}`);
      continue;
    }
    webkitDir = available.dir;
  }
  const runs = [];
  for (const entry of selected) {
    const started = Date.now();
    const run = engine === "webkit" ? await runWebkitCase(entry, webkitDir) : await runChromiumCase(entry);
    run.evaluation = evaluate(run, reference);
    runs.push(run);
    if (!run.evaluation.passed) failed = true;
    console.log(`[${engine}] ${entry.id} ${run.evaluation.passed ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)} s: ${run.evaluation.checks.join("; ")}`);
    const outPath = process.env.LADDER_OUT ?? join(repoRoot, `docs/validation/solve-ladder/${date}-${engine}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify({ generatedBy: "scripts/verify-solve-ladder.mjs", date, machine, engine, runs }, null, 2)}\n`);
  }
  console.log(`\n| Case | Engine | DOF total / free | Assemble s | Solve s | CG iterations | Precond | Final rel. residual | Worker heap | UA memory | Process peak | Gates |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const run of runs) console.log(tableRow(run));
}
server.close();
process.exit(failed ? 1 : 0);
