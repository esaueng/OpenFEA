import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { MessageSquare } from "lucide-react";
import type { Study } from "@openfea/schema";
import { REQUIRED_SETTING_HELP_IDS, SETTING_HELP, type SettingHelpVisual } from "../settingHelp";

export interface WorkspaceLogEntry {
  message: string;
  at: number;
}

interface BottomPanelProps {
  status: string;
  logs: WorkspaceLogEntry[];
  meshStatus: string;
  solverStatus: string;
  /** One-line study summary shown beside the status, e.g. "1 support, 1 load". */
  studySummary?: string;
  onClearLogs: () => void;
}

export const WORKSPACE_SHORTCUT_GUIDE: Array<{ keys: string[]; label: string }> = [
  { keys: ["N"], label: "Next workflow step" },
  { keys: ["B"], label: "Previous workflow step" },
  { keys: ["H"], label: "Fit view / home view" },
  { keys: ["Ctrl/Cmd", "S"], label: "Save project" },
  { keys: ["Ctrl/Cmd", "Z"], label: "Undo" },
  { keys: ["Shift", "Ctrl/Cmd", "Z"], label: "Redo" }
];

const ESAU_ENGINEERING_URL = "https://esauengineering.com/";
const COPY_FEEDBACK_DURATION_MS = 2200;

export async function writeWorkspaceLogsToClipboard(text: string, clipboard?: Pick<Clipboard, "writeText">): Promise<"copied" | "unavailable" | "failed"> {
  if (!clipboard) return "unavailable";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

export function BottomPanel({ status, logs, meshStatus, solverStatus, studySummary, onClearLogs }: BottomPanelProps) {
  const [tab, setTab] = useState<"help" | "logs" | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(320);
  // Clearing asks once, inline, like the geometry-replace and analysis-type confirms. The
  // old "click again" arm let a double-click clear the log in one gesture.
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const clearCancelRef = useRef<HTMLButtonElement>(null);
  const restoreClearFocusRef = useRef(false);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "copied" | "unavailable" | "failed">("idle");
  const [tipFilter, setTipFilter] = useState("");
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  const copyFeedbackTimeoutRef = useRef(0);
  const expanded = tab !== null;
  const displayStatus = statusForDisplay(status, solverStatus);
  // A solve that ends while the user is elsewhere must still be heard: remember the
  // outcome of the last transition out of Running and prefix it to the message that
  // was current at that moment, until a newer message replaces it. Derived during
  // render (not in an effect) so the region never flashes the bare message first.
  const [trackedSolverStatus, setTrackedSolverStatus] = useState(solverStatus);
  const [solveOutcome, setSolveOutcome] = useState<{ text: string; status: string } | null>(null);
  if (trackedSolverStatus !== solverStatus) {
    setTrackedSolverStatus(solverStatus);
    const text = solveOutcomeAnnouncement(trackedSolverStatus, solverStatus);
    setSolveOutcome(text ? { text, status } : null);
  }
  const liveStatus = liveStatusMessage(status, solverStatus, solveOutcome);
  const healthy = solverStatus === "Running" ? "running" : displayStatus === "Solve failed" || displayStatus === "Needs attention" || displayStatus === "Results outdated" ? "warning" : meshStatus === "Ready" ? "ready" : "warning";
  const formattedLogs = logs.map(formatLogEntry);
  // 43 guides is more than anyone scans. Filter across title and body so a user who knows
  // roughly what they are looking for can get to it.
  const matchingTipIds = tipFilter.trim()
    ? REQUIRED_SETTING_HELP_IDS.filter((helpId) => {
        const help = SETTING_HELP[helpId];
        const needle = tipFilter.trim().toLowerCase();
        return help.title.toLowerCase().includes(needle) || help.body.toLowerCase().includes(needle);
      })
    : REQUIRED_SETTING_HELP_IDS;

  // Focus lands on the safe action when the confirm opens and returns to the
  // Clear logs button when it is dismissed without clearing.
  useEffect(() => {
    if (clearConfirmOpen) {
      clearCancelRef.current?.focus();
    } else if (restoreClearFocusRef.current) {
      restoreClearFocusRef.current = false;
      clearButtonRef.current?.focus();
    }
  }, [clearConfirmOpen]);

  // Nothing left to clear (another path emptied the log): drop a stale confirm.
  if (clearConfirmOpen && !logs.length) setClearConfirmOpen(false);

  useEffect(() => () => window.clearTimeout(copyFeedbackTimeoutRef.current), []);

  function selectTab(nextTab: NonNullable<typeof tab>, event: MouseEvent<HTMLButtonElement>) {
    if (tab === nextTab) {
      setTab(null);
      event.currentTarget.blur();
      return;
    }
    setTab(nextTab);
  }

  function startDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragStart.current = { y: event.clientY, height: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDrawer(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current) return;
    const maxHeight = Math.max(260, window.innerHeight - 120);
    const nextHeight = dragStart.current.height + dragStart.current.y - event.clientY;
    setDrawerHeight(Math.min(maxHeight, Math.max(260, nextHeight)));
  }

  function stopDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeDrawerByKey(event: KeyboardEvent<HTMLButtonElement>) {
    const maxHeight = Math.max(260, window.innerHeight - 120);
    const clamp = (value: number) => Math.min(maxHeight, Math.max(260, value));
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = drawerHeight + 24;
    else if (event.key === "ArrowDown") nextHeight = drawerHeight - 24;
    else if (event.key === "Home") nextHeight = 260;
    else if (event.key === "End") nextHeight = maxHeight;
    if (nextHeight === null) return;
    event.preventDefault();
    setDrawerHeight(clamp(nextHeight));
  }

  async function copyLogs() {
    window.clearTimeout(copyFeedbackTimeoutRef.current);
    const outcome = await writeWorkspaceLogsToClipboard(
      formattedLogs.join("\n"),
      typeof navigator === "undefined" ? undefined : navigator.clipboard
    );
    setCopyFeedback(outcome);
    copyFeedbackTimeoutRef.current = window.setTimeout(() => setCopyFeedback("idle"), COPY_FEEDBACK_DURATION_MS);
  }

  function requestClearLogs(event: MouseEvent<HTMLButtonElement>) {
    if (!logs.length || !isDeliberateClick(event.detail)) return;
    setClearConfirmOpen(true);
  }

  function cancelClearLogs() {
    restoreClearFocusRef.current = true;
    setClearConfirmOpen(false);
  }

  function confirmClearLogs(event: MouseEvent<HTMLButtonElement>) {
    // The second click of a double-click on "Clear logs" lands here; it must not clear.
    if (!isDeliberateClick(event.detail)) return;
    setClearConfirmOpen(false);
    onClearLogs();
  }

  return (
    <footer className={`bottom-panel ${expanded ? "expanded" : ""}`}>
      {expanded && tab === "logs" && (
        <div className="bottom-content logs-content" style={{ height: drawerHeight }}>
          <button
            type="button"
            className="bottom-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={drawerHeight}
            aria-valuemin={260}
            aria-valuemax={Math.max(260, window.innerHeight - 120)}
            aria-label="Resize drawer (use arrow keys)"
            title="Drag up to resize"
            onPointerDown={startDrawerResize}
            onPointerMove={resizeDrawer}
            onPointerUp={stopDrawerResize}
            onPointerCancel={stopDrawerResize}
            onKeyDown={resizeDrawerByKey}
          />
          <div className="logs-drawer-header">
            <span>Run logs</span>
            <div className="logs-drawer-actions">
              <span className={`log-copy-feedback ${copyFeedback}`} role="status" aria-live="polite" aria-atomic="true">
                {copyFeedback === "copied" ? "Logs copied to clipboard." : copyFeedback === "unavailable" ? "Clipboard unavailable. Select the logs and copy manually." : copyFeedback === "failed" ? "Copy failed. Select the logs and copy manually." : ""}
              </span>
              <button type="button" className="log-copy-button" onClick={() => void copyLogs()}>{copyFeedback === "copied" ? "Copied" : copyFeedback === "failed" || copyFeedback === "unavailable" ? "Copy failed" : "Copy logs"}</button>
              {clearConfirmOpen ? (
                <span
                  className="log-clear-confirm"
                  role="group"
                  aria-label="Confirm clearing run logs"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.stopPropagation();
                    cancelClearLogs();
                  }}
                >
                  <span className="log-clear-confirm-copy">{clearLogsQuestion(logs.length)}</span>
                  <button ref={clearCancelRef} type="button" className="log-copy-button" onClick={cancelClearLogs}>Keep logs</button>
                  <button type="button" className="log-clear-button log-clear-confirm-button" onClick={confirmClearLogs}>Clear</button>
                </span>
              ) : (
                <button
                  ref={clearButtonRef}
                  type="button"
                  className="log-clear-button"
                  disabled={!logs.length}
                  onClick={requestClearLogs}
                >
                  Clear logs
                </button>
              )}
            </div>
          </div>
          <pre tabIndex={0} aria-label="Run log output">
            {logs.map((entry, index) => {
              const { time, level, message } = logEntryParts(entry);
              return (
                <div className={`log-line log-${level.toLowerCase()}`} key={`${entry.at}-${index}`}>
                  <span className="log-time">{time}</span>
                  <span className="log-level">{level}</span>
                  <span className="log-message">{message}</span>
                </div>
              );
            })}
          </pre>
        </div>
      )}
      {expanded && tab === "help" && (
        <div className="bottom-content tips-content" style={{ height: drawerHeight }}>
          <button
            type="button"
            className="bottom-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={drawerHeight}
            aria-valuemin={260}
            aria-valuemax={Math.max(260, window.innerHeight - 120)}
            aria-label="Resize drawer (use arrow keys)"
            title="Drag up to resize"
            onPointerDown={startDrawerResize}
            onPointerMove={resizeDrawer}
            onPointerUp={stopDrawerResize}
            onPointerCancel={stopDrawerResize}
            onKeyDown={resizeDrawerByKey}
          />
          <div className="tips-drawer-header">
            <span>Help · Settings tips</span>
            <input
              type="search"
              className="tips-filter"
              value={tipFilter}
              placeholder="Filter guides"
              aria-label="Filter settings guides"
              onChange={(event) => setTipFilter(event.currentTarget.value)}
            />
            <strong>{matchingTipIds.length} of {REQUIRED_SETTING_HELP_IDS.length}</strong>
          </div>
          <div className="tips-grid">
            {matchingTipIds.length === 0 && <p className="tips-empty">No guide matches “{tipFilter}”.</p>}
            {matchingTipIds.map((helpId) => {
              const help = SETTING_HELP[helpId];
              return (
                <article className="tip-card" key={helpId}>
                  <TipVisual kind={help.visual} />
                  <span>
                    <strong>{help.title}</strong>
                    <small>{help.body}</small>
                  </span>
                </article>
              );
            })}
          </div>
        </div>
      )}
      <div className="status-strip">
        <div className="status-primary">
          <div className="status-groups" aria-label="Simulation status">
            <span className={`status-state ${healthy}`}><i /><span className="status-state-label">{displayStatus}</span></span>
            {/* The latest message, not just the derived state word beside it. A polite live
                region; during a solve it holds one line instead of reading every ETA tick. */}
            <span className="status-message" role="status" aria-live="polite" aria-atomic="true" title={liveStatus || undefined}>{liveStatus}</span>
            {studySummary ? <span className="status-summary">{studySummary}</span> : null}
          </div>
        </div>
        <a className="status-attribution" href={ESAU_ENGINEERING_URL} target="_blank" rel="noreferrer">Built by Esau Engineering</a>
        <div className="status-links" aria-label="Help and feedback">
          <div className="status-tabs">
            {(["help", "logs"] as const).map((item) => (
              <button key={item} type="button" className={tab === item ? "active" : ""} aria-pressed={tab === item} aria-expanded={tab === item} onClick={(event) => selectTab(item, event)}>
                {item === "help" ? "Help" : "Logs"}
                {item === "logs" && <span className="count-pill">{logs.length}</span>}
              </button>
            ))}
          </div>
          <a className="status-link" href="https://form.esauengineering.com/opencae-feedback" target="_blank" rel="noreferrer">
            <MessageSquare size={13} aria-hidden="true" />
            Feedback
          </a>
        </div>
      </div>
    </footer>
  );
}

function TipVisual({ kind }: { kind: SettingHelpVisual }) {
  return (
    <span className={`help-visual ${kind}`} aria-hidden="true">
      <span className="help-part" />
      <span className="help-force" />
      <span className="help-grid" />
    </span>
  );
}

export function KeyboardShortcutGuide() {
  return (
    <section className="shortcut-guide" aria-labelledby="shortcut-guide-title">
      <div className="shortcut-guide-header">
        <strong id="shortcut-guide-title">Keyboard shortcuts</strong>
        <span>Workspace</span>
      </div>
      <div className="shortcut-list">
        {WORKSPACE_SHORTCUT_GUIDE.map((shortcut) => (
          <div className="shortcut-item" key={`${shortcut.keys.join("+")}-${shortcut.label}`}>
            <span className="shortcut-keys">
              {shortcut.keys.map((key, index) => (
                <span className="shortcut-key" key={`${shortcut.label}-${key}-${index}`}>
                  {index > 0 && <span aria-hidden="true">+</span>}
                  <kbd>{key}</kbd>
                </span>
              ))}
            </span>
            <span>{shortcut.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Run health comes from the run's own state; the log message is only a
 * fallback for statuses restored from a previous session.
 *
 * The word list below cannot classify prose it was not written for. A solver
 * rejection reading "OpenFEA Core requires a load with a finite positive value
 * and direction" contains "openfea core" and none of these words, so it fell
 * through to "OpenFEA Core active" — the footer reported health while the run
 * had just been refused. Any future message phrased outside the list would do
 * the same, which is why `solverStatus` is consulted first.
 */
/**
 * Pill labels speak to the user, not about the runtime: "OpenFEA Core error"
 * and "OpenFEA Core active" named the solver product instead of the state the
 * user is in (2026-09 review F12). "Results outdated" is new: an edit cleared
 * the last results and a re-run is needed.
 */
export function statusForDisplay(status: string, solverStatus: string) {
  if (solverStatus === "Error") return "Solve failed";
  const normalized = status.toLowerCase();
  if (normalized.includes("openfea core") && /(error|fail|failed|unavailable|not configured|not enabled|not ready)/.test(normalized)) return "Solve failed";
  if (/(could not|failed)/.test(normalized)) return "Needs attention";
  if (solverStatus === "Running") return "Simulating";
  if (solverStatus === "Outdated") return "Results outdated";
  // Keyed off the solver, not the words in the message: any status containing "complete"
  // used to light the pill green, including "Mesh-convergence study complete" (which
  // leaves the working mesh and results untouched) and "Completed results were ignored".
  if (solverStatus === "Complete") return "Results ready";
  return "Ready";
}

/**
 * What to announce when a solve settles. Only a transition out of "Running" says
 * anything; every other change is carried by the latest message alone.
 */
export function solveOutcomeAnnouncement(previousSolverStatus: string, solverStatus: string): string | null {
  if (previousSolverStatus !== "Running" || solverStatus === "Running") return null;
  if (solverStatus === "Complete") return "Simulation complete. Results are ready.";
  if (solverStatus === "Error") return "Simulation failed.";
  return "Simulation stopped.";
}

/**
 * The text of the status bar's live region: the latest message, held at one line
 * while a solve runs (progress messages arrive every tick and would flood a screen
 * reader), and prefixed with the solve outcome while the message that was current
 * when the solve ended is still the latest one.
 */
export function liveStatusMessage(status: string, solverStatus: string, solveOutcome: { text: string; status: string } | null): string {
  if (solverStatus === "Running") return "Simulation running.";
  if (solveOutcome && solveOutcome.status === status) return status ? `${solveOutcome.text} ${status}` : solveOutcome.text;
  return status;
}

/**
 * The status bar's one-line study summary. Counts only what the user placed;
 * modal studies take no loads, so their load count is left out.
 */
export function studySummaryLine(study: Pick<Study, "type" | "constraints" | "loads"> | null | undefined): string {
  if (!study) return "";
  const count = (n: number, singular: string, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
  if (study.type === "steady_state_thermal") {
    return `${count(study.constraints.length, "fixed temperature")}, ${count(study.loads.length, "heat load")}`;
  }
  const supports = count(study.constraints.length, "support");
  if (study.type === "modal_analysis") return supports;
  return `${supports}, ${count(study.loads.length, "load")}`;
}

/**
 * A deliberate single activation: `detail` is 1 for a click and 0 for keyboard
 * activation; a double-click's follow-up clicks report 2 and up and are ignored, so
 * no double-click can both open the clear confirm and accept it.
 */
export function isDeliberateClick(clickDetail: number): boolean {
  return clickDetail <= 1;
}

export function clearLogsQuestion(lineCount: number): string {
  return `Clear ${lineCount.toLocaleString()} log ${lineCount === 1 ? "line" : "lines"}?`;
}

export type WorkspaceLogLevel = "OK" | "ERR" | "INFO";

export function workspaceLogLevel(message: string): WorkspaceLogLevel {
  const normalized = message.toLowerCase();
  if (normalized.includes("complete") || normalized.includes("generated")) return "OK";
  if (/(error|fail|failed|unavailable|not configured|not enabled)/.test(normalized)) return "ERR";
  return "INFO";
}

/* The level was computed for every line and then flattened straight back into one string,
   so a mesh crash looked exactly like "Mesh generated" — same colour, same weight, only
   the word differed. It is kept as data here and coloured at render. */
function logEntryParts(entry: WorkspaceLogEntry) {
  return {
    time: new Date(entry.at).toLocaleTimeString([], { hour12: false }),
    level: workspaceLogLevel(entry.message),
    message: entry.message
  };
}

function formatLogEntry(entry: WorkspaceLogEntry) {
  const { time, level, message } = logEntryParts(entry);
  return `${time} ${level.padEnd(4, " ")} ${message}`;
}
