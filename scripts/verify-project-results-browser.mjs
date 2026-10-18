// Regression: history must invalidate results; portable files must contain all dynamic cases.
// Run with: node scripts/verify-project-results-browser.mjs (Chrome; ports 5199 and 9337).
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCdpClient } from "./browser-cdp.mjs";

const PORT = Number(process.env.PORT ?? 5199);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const profileDir = mkdtempSync(join(tmpdir(), "openfea-project-results-"));
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

function spawnChild(command, args, options = {}) {
  if (process.platform === "win32" && /msedge\.exe$/i.test(command)) args = [...args, "--edge-skip-compat-layer-relaunch"];
  // Use the current pnpm entry point rather than shelling out to pnpm.cmd.
  if (process.platform === "win32" && command === "pnpm" && process.env.npm_execpath) {
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
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
      // Already stopped.
    }
  }
}

function cleanup() {
  for (const child of children) killChild(child);
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(2));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 30_000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectCdp() {
  const target = await waitFor("Chrome DevTools endpoint", async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const targets = await response.json();
    return targets.find((candidate) => candidate.type === "page") ?? null;
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return createCdpClient(socket);
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails).slice(0, 800));
  }
  return response.result?.result?.value;
}

async function callInPage(cdp, fn, ...args) {
  const target = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const response = await cdp.send("Runtime.callFunctionOn", {
    objectId: target.result.result.objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map(value => ({ value })),
    awaitPromise: true,
    returnByValue: true
  }, { timeoutMs: 240_000 }); // Includes the real modal solve's 180-second deadline.
  if (response.error || response.result?.exceptionDetails) {
    throw new Error(JSON.stringify(response.error ?? response.result.exceptionDetails).slice(0, 800));
  }
  return response.result?.result?.value;
}

let activeCdp;

async function run() {
  spawnChild("pnpm", ["--filter", "@openfea/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: repoRoot });
  await waitFor("Vite", async () => (await fetch(`http://127.0.0.1:${PORT}/`)).ok);
  spawnChild(chromeBinary(), ["--headless=new", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${CDP_PORT}`, "about:blank"]);
  const cdp = await connectCdp();
  activeCdp = cdp;
  const errors = [];
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  cdp.on("Runtime.exceptionThrown", (params) => errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text));
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await waitFor("app", () => evaluate(cdp, 'document.title.includes("OpenFEA") && document.body.innerText.includes("New study")'));
  const fixture = await waitFor("fixture imports", () => evaluate(cdp, `(async () => {
    const { loadSampleProject } = await import('/src/lib/api.ts');
    const { project, displayModel } = await loadSampleProject('cantilever', 'dynamic_structural');
    const summary = { maxStress: 10, maxStressUnits: 'MPa', maxDisplacement: 0.1, maxDisplacementUnits: 'mm', safetyFactor: 2, reactionForce: 100, reactionForceUnits: 'N', transient: { analysisType: 'dynamic_structural', frameCount: 2, startTime: 0, endTime: 1, timeStep: 1, outputInterval: 1, peakDisplacement: 0.1, peakDisplacementTimeSeconds: 1 } };
    const variant = id => ({ id, name: id, kind: 'case', caseId: id, summary, fields: [0, 1].flatMap(frameIndex => ['stress', 'displacement'].map(type => ({ id: id + '-' + type + '-' + frameIndex, runId: 'run-local-history-proof', variantId: id, type, location: 'face', values: displayModel.faces.map(() => type === 'stress' ? 10 : 0.1), min: type === 'stress' ? 10 : 0.1, max: type === 'stress' ? 10 : 0.1, units: type === 'stress' ? 'MPa' : 'mm', frameIndex, timeSeconds: frameIndex }))) });
    const active = variant('Down');
    const other = variant('Side');
    const previous = structuredClone(project);
    previous.studies[0].loads[0].parameters.value = 250;
    project.studies[0].loads[0].parameters.value = 500;
    return { project, previous, displayModel, active, other, results: { completedRunId: 'run-local-history-proof', summary, fields: active.fields, variants: [active], variantRefs: [active, other].map(({id,name,kind,caseId}) => ({id,name,kind,caseId,persistedSeparately:true})), activeVariantId: active.id } };
  })()`));
  async function restore(projectFile, ui, readySelector = ".result-variant-selector select") {
    const token = `${Date.now()}-${Math.random()}`;
    await callInPage(cdp, (projectFile, ui, token) => {
      sessionStorage.setItem('openfea-test-fixture', JSON.stringify({ projectFile, ui, token }));
    }, projectFile, ui, token);
    const injection = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const fixture = JSON.parse(sessionStorage.getItem('openfea-test-fixture'));
      sessionStorage.removeItem('openfea-test-fixture');
      window.__projectFixtureToken = fixture.token;
      localStorage.clear();
      localStorage.setItem('opencae.workspace.autosave.v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), projectFile: fixture.projectFile, ui: fixture.ui }));
    })()` });
    await cdp.send("Page.reload");
    await waitFor("restored results", () => callInPage(cdp, (token, selector) => window.__projectFixtureToken === token && Boolean(document.querySelector(selector)), token, readySelector));
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection.result.identifier });
    await evaluate(cdp, `(() => {
      window.__savedProject = null;
      window.showSaveFilePicker = async () => ({ name: 'proof.openfea.json', createWritable: async () => ({ write: async blob => { window.__savedProject = JSON.parse(await blob.text()); }, close: async () => {} }) });
    })()`);
  }
  async function save() {
    await evaluate(cdp, `(() => { window.__savedProject = null; window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); })()`);
    return waitFor("saved project", () => evaluate(cdp, 'window.__savedProject'));
  }
  const projectFile = { format: "openfea-local-project", version: 2, savedAt: new Date().toISOString(), project: fixture.project, displayModel: fixture.displayModel, results: fixture.results };
  const ui = { activeStep: "results", viewMode: "results", homeRequested: false, resultMode: "stress", logs: [], undoStack: [fixture.previous], redoStack: [], runProgress: 100, completedRunId: "run-local-history-proof" };
  for (const direction of ["Undo", "Redo"]) {
    await restore(projectFile, { ...ui, undoStack: direction === "Undo" ? [fixture.previous] : [], redoStack: direction === "Redo" ? [fixture.previous] : [] });
    await evaluate(cdp, `document.querySelector('[aria-label="${direction} last change"]').click()`);
    await waitFor("cleared results", () => evaluate(cdp, '!document.querySelector(".result-variant-selector select")'));
    const saved = await save();
    if (saved.results || saved.project.studies[0].loads[0].parameters.value !== 250) throw new Error(`${direction} retained stale results or did not restore the load`);
    console.log(`${direction}: load restored; stale results absent from UI and saved file.`);
  }
  await restore(projectFile, ui);
  await callInPage(cdp, async variant => {
    const store = await import('/src/lib/localResultsStore.ts');
    await store.saveLocalRunVariantResult('run-local-history-proof', 'Side', variant);
  }, fixture.other);
  const saved = await save();
  if (saved.results.variants.length !== 2 || saved.results.variantRefs.some(ref => ref.persistedSeparately)) throw new Error('Save omitted a case or retained storage dependencies');
  await evaluate(cdp, `(async () => { const store = await import('/src/lib/localResultsStore.ts'); await store.deleteLocalRunVariantResults('run-local-history-proof'); })()`);
  await restore(saved, { ...ui, undoStack: [], redoStack: [] });
  for (const id of ['Side', 'Down', 'Side']) {
    await evaluate(cdp, `(() => { const select = document.querySelector('.result-variant-selector select'); select.value = '${id}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`case ${id}`, () => evaluate(cdp, `document.querySelector('.result-variant-selector select')?.value === '${id}'`));
  }
  const resaved = await save();
  if (resaved.results.variants.length !== 2 || resaved.results.activeVariantId !== 'Side') throw new Error('Reopened cases were lost when switching');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Portable results: both cases survive save, storage deletion, reopen, repeated switching, and resave.');
  // Exercise a real six-mode browser solve, rather than fabricating modal fields.
  const modalFile = await callInPage(cdp, async () => {
    const api = await import('/src/lib/api.ts');
    const { buildLocalProjectFile } = await import('/src/projectFile.ts');
    const { project, displayModel } = await api.loadSampleProject('cantilever', 'modal_analysis');
    // Exercise the same mesh entry point as Generate mesh before solving.
    // Structured samples must produce real counts without estimate opt-in.
    const generated = await api.generateMesh(project.studies[0].id, 'coarse', project.studies[0], displayModel);
    const study = generated.study;
    project.studies[0] = study;
    if (study.meshSettings.summary?.source !== 'core_solver') throw new Error('Cantilever meshing did not generate a real structured grid');
    study.solverSettings.modeCount = 6;
    const { run } = await api.runSimulation(study.id, study, displayModel);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stream.close(); void api.cancelRun(run.id); reject(new Error('Six-mode solve timed out')); }, 180_000);
      const stream = api.subscribeToRun(run.id, event => {
        if (event.type !== 'complete' && event.type !== 'error' && event.type !== 'cancelled') return;
        clearTimeout(timer);
        stream.close();
        if (event.type === 'complete') resolve();
        else reject(new Error(event.message));
      });
    });
    const results = await api.getResults(run.id);
    const mesh = results.artifacts?.meshStatistics;
    if (mesh?.nodes !== study.meshSettings.summary.nodes || mesh?.elements !== study.meshSettings.summary.elements) throw new Error('Generated cantilever mesh counts differ from the solver mesh');
    if (results.summary.convergedModeCount !== 6 || results.fields.length !== 6) throw new Error('Six-mode solve omitted a mode');
    if (results.summary.modes.some(mode => mode.scaledResidual > 1e-6)) throw new Error('Modal residual exceeded tolerance');
    study.runs = [{ ...run, status: 'complete' }];
    return buildLocalProjectFile(project, displayModel, new Date().toISOString(), { ...results, completedRunId: run.id });
  });
  const modalUi = { ...ui, undoStack: [], redoStack: [], sampleModel: 'cantilever', sampleAnalysisType: 'modal_analysis', resultMode: 'mode_shape', showDeformed: true, selectedModeIndex: 1, completedRunId: modalFile.results.completedRunId };
  await restore(modalFile, modalUi, '.modal-mode-table');
  const modalBaseline = await save();
  const canonicalModes = fields => fields.map(({ id, modeIndex, frequencyHz, eigenvalue, scaledResidual, values, vectors, units, surfaceMeshRef, location }) => ({ id, modeIndex, frequencyHz, eigenvalue, scaledResidual, values, vectors, units, surfaceMeshRef, location }));
  // Import deliberately reclassifies provenance; numerical modal data must survive intact.
  assert.deepEqual(canonicalModes(modalBaseline.results.fields), canonicalModes(modalFile.results.fields));
  async function renderedModeHash() {
    return callInPage(cdp, nodeCount => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      let fiber = canvas[Object.keys(canvas).find(key => key.startsWith('__reactFiber'))];
      let store;
      while (fiber && !store) {
        let hook = fiber.memoizedState;
        while (hook) { store = hook.memoizedState?.current?.__r3f?.root; if (store) break; hook = hook.next; }
        fiber = fiber.return;
      }
      let hash = null;
      store?.getState().scene.traverse(object => {
        const geometry = object.geometry;
        const position = geometry?.getAttribute('position');
        if (!object.isMesh || geometry?.getAttribute('color')?.count !== nodeCount || !position) return;
        const bytes = new Uint8Array(position.array.buffer, position.array.byteOffset, position.array.byteLength);
        let value = 2166136261;
        for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
        hash = value >>> 0;
      });
      return hash;
    }, modalFile.results.surfaceMesh.nodes.length);
  }
  const renderedModes = new Set();
  for (const mode of modalFile.results.summary.modes) {
    await callInPage(cdp, modeIndex => document.querySelector(`[aria-label^="Mode ${modeIndex},"]`).click(), mode.modeIndex);
    await waitFor(`mode ${mode.modeIndex}`, () => callInPage(cdp, modeIndex => document.querySelector(`[aria-label^="Mode ${modeIndex},"]`)?.getAttribute('aria-pressed') === 'true', mode.modeIndex));
    const phase = await evaluate(cdp, `(() => {
      const range = document.querySelector('[aria-label="Mode phase"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, '12');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return Number(range.max);
    })()`);
    if (phase !== 23) throw new Error('Modal phase frames were lost');
    await waitFor('half-cycle phase', () => evaluate(cdp, `document.querySelector('[aria-label="Mode phase"]').value === '12'`));
    const renderedHash = await waitFor(`rendered mode ${mode.modeIndex}`, async () => {
      const hash = await renderedModeHash();
      return hash !== null && !renderedModes.has(hash) ? hash : null;
    });
    renderedModes.add(renderedHash);
    const modalSaved = await save();
    assert.deepEqual(modalSaved.results.fields, modalBaseline.results.fields, 'Mode selection or phase altered canonical saved fields');
  }
  const modalSaved = await save();
  await restore(modalSaved, { ...modalUi, selectedModeIndex: 6 }, '.modal-mode-table');
  const reopenedModal = await save();
  if (reopenedModal.results.fields.length !== 6 || reopenedModal.results.summary.convergedModeCount !== 6) throw new Error('Reopen lost modal modes');
  assert.deepEqual(canonicalModes(reopenedModal.results.fields), canonicalModes(modalFile.results.fields));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Modal results: six converged modes survive selection, phase changes, save, reopen, and resave without modifying canonical fields.');
  await cdp.send("Browser.close");
  await sleep(1000);
}

try {
  await run();
  console.log("PROJECT RESULTS OK");
  process.exit(0);
} catch (error) {
  if (activeCdp) console.error(await evaluate(activeCdp, 'JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 5000) })').catch(() => 'Page unavailable'));
  console.error(`PROJECT RESULTS FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
