import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SampleAnalysisType, SampleModelId } from "../lib/api";
import { getOfflineReadiness, offlineReadinessLabel, subscribeOfflineReadiness } from "../lib/offlineStatus";
import { OpenFeaLogoMark } from "./OpenFeaLogoMark";
import { SampleOptionCard } from "./SampleOptionCard";
import { SAMPLE_ANALYSIS_OPTIONS } from "./sampleAnalysisOptions";
import { SAMPLE_OPTIONS, sampleOptionFor } from "./sampleOptions";
import { defaultRecentProjectService, isRecentProjectsSupported, pickRecentProjectFile, projectNameFromFile, requestRecentProjectFile, type RecentProjectEntry, type RecentProjectFileHandle, type RecentProjectService } from "../recentProjects";

interface StartScreenProps {
  onLoadSample: (sample?: SampleModelId, analysisType?: SampleAnalysisType) => void;
  onCreateProject: () => void;
  onOpenProject: (file: File, handle?: RecentProjectFileHandle) => void | Promise<void>;
  /** True while the workspace chunk loads after a click; the pressed action reads as busy instead of dead (2026-09 review D23). */
  busy?: boolean;
  /** The project still held in memory after "Back to start", so it can be resumed rather than silently replaced. */
  continueProject?: { name: string; onContinue: () => void };
}

export function StartScreen({ onLoadSample, onCreateProject, onOpenProject, busy = false, continueProject }: StartScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Truthful cache state (see lib/offlineStatus.ts): "Offline-ready" only
  // once the service worker reports every precached asset (wasm included) in
  // cache; nothing at all when there is no service worker.
  const offlineReadiness = useSyncExternalStore(subscribeOfflineReadiness, getOfflineReadiness, getOfflineReadiness);
  const offlineLabel = offlineReadinessLabel(offlineReadiness);
  const [selectedAnalysisType, setSelectedAnalysisType] = useState<SampleAnalysisType>("static_stress");
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>([]);
  const [recentsAvailable, setRecentsAvailable] = useState(() => isRecentProjectsSupported());
  const [recentError, setRecentError] = useState<string | null>(null);
  const [recentBusyId, setRecentBusyId] = useState<string | null>(null);
  const recentServiceRef = useRef<RecentProjectService | null>(null);
  if (!recentServiceRef.current) recentServiceRef.current = defaultRecentProjectService();

  useEffect(() => {
    if (!recentsAvailable) return undefined;
    let cancelled = false;
    void recentServiceRef.current!.list().then((entries) => {
      if (!cancelled) setRecentProjects(entries);
    }).catch((error) => {
      if (cancelled) return;
      setRecentsAvailable(false);
      setRecentError(messageFromError(error, "Recent Projects is unavailable."));
    });
    return () => { cancelled = true; };
  }, [recentsAvailable]);

  function loadSample(sample: SampleModelId) {
    onLoadSample(sample, selectedAnalysisType);
  }

  async function openValidatedProject(file: File, handle?: RecentProjectFileHandle) {
    setRecentError(null);
    const projectName = await projectNameFromFile(file);
    if (handle && recentsAvailable) {
      try {
        setRecentProjects(await recentServiceRef.current!.add(handle, { filename: file.name, projectName }));
      } catch (error) {
        setRecentsAvailable(false);
        setRecentError(messageFromError(error, "Recent Projects could not be updated."));
      }
    }
    await onOpenProject(file, handle);
  }

  async function chooseLocalProject() {
    if (!recentsAvailable) {
      fileInputRef.current?.click();
      return;
    }
    setRecentBusyId("picker");
    setRecentError(null);
    try {
      const selected = await pickRecentProjectFile();
      if (selected !== "cancelled") await openValidatedProject(selected.file, selected.handle);
    } catch (error) {
      setRecentError(messageFromError(error, "Could not open the selected project."));
    } finally {
      setRecentBusyId(null);
    }
  }

  async function openRecentProject(entry: RecentProjectEntry) {
    setRecentBusyId(entry.id);
    setRecentError(null);
    try {
      const file = await requestRecentProjectFile(entry);
      await openValidatedProject(file, entry.handle);
    } catch (error) {
      setRecentError(messageFromError(error, `Could not open ${entry.filename}.`));
    } finally {
      setRecentBusyId(null);
    }
  }

  async function removeRecentProject(id: string) {
    setRecentError(null);
    try {
      setRecentProjects(await recentServiceRef.current!.remove(id));
    } catch (error) {
      setRecentError(messageFromError(error, "Could not remove the recent project."));
    }
  }

  async function clearRecentProjects() {
    setRecentError(null);
    try {
      await recentServiceRef.current!.clear();
      setRecentProjects([]);
    } catch (error) {
      setRecentError(messageFromError(error, "Could not clear Recent Projects."));
    }
  }

  const tryLabel = `${sampleOptionFor("bracket").title} · ${START_ANALYSIS_LABELS[selectedAnalysisType].toLowerCase()}`;

  return (
    <main
      className="start-screen"
      tabIndex={0}
      onKeyDown={(event) => {
        // Only when <main> itself has focus. Unguarded, these fired from any focused
        // descendant — WCAG 2.1.4, which the workspace's own single-key handler already
        // cites and honours.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (!busy) loadSample("bracket");
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "n") {
          event.preventDefault();
          onCreateProject();
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "o") {
          event.preventDefault();
          void chooseLocalProject();
        }
      }}
    >
      <div className="start-column">
        <header className="start-brand" aria-labelledby="openfea-title">
          <OpenFeaLogoMark className="start-mark" title="OpenFEA mark" />
          <h1 id="openfea-title">OpenFEA</h1>
          <p className="start-lede">See how a part bends and where it is stressed — right in your browser. Nothing leaves this device.</p>
        </header>

        <section className="start-actions" aria-label="Get started" aria-busy={busy}>
          {busy && <p className="start-busy" role="status" aria-live="polite">Opening the workspace…</p>}
          {continueProject && (
            <button className="start-action start-continue primary" type="button" disabled={busy} onClick={() => continueProject.onContinue()}>
              <span>
                <strong>Continue {continueProject.name}</strong>
                <small>Your last project is still open in this browser</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          )}
          <div className="start-action-grid">
            <button className={`start-action ${continueProject ? "secondary" : "primary"} sample-action`} type="button" disabled={busy} onClick={() => loadSample("bracket")}>
              <span>
                <strong>Try a sample</strong>
                <small>{tryLabel}, already set up</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
            <button className="start-action secondary" type="button" disabled={busy} onClick={() => onCreateProject()}>
              <span>
                <strong>New study</strong>
                <small>Start from your own geometry</small>
              </span>
              <kbd>N</kbd>
            </button>
            <button className="start-action secondary" type="button" disabled={busy || recentBusyId === "picker"} onClick={() => void chooseLocalProject()}>
              <span>
                <strong>Open a project file</strong>
                <small>An .openfea.json saved on this device</small>
              </span>
              <kbd>O</kbd>
            </button>
          </div>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".json,.openfea,.openfea.json,.opencae,.opencae.json,application/json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void openValidatedProject(file).catch((error) => setRecentError(messageFromError(error, "Could not open the selected project.")));
            }}
          />
        </section>

        <StartSamplesSection
          analysisType={selectedAnalysisType}
          disabled={busy}
          onSelectAnalysisType={setSelectedAnalysisType}
          onLoadSample={loadSample}
        />

        {recentsAvailable && (
          <RecentProjectsSection
            entries={recentProjects}
            busyId={recentBusyId}
            onOpen={(entry) => void openRecentProject(entry)}
            onRemove={(id) => void removeRecentProject(id)}
            onClear={() => void clearRecentProjects()}
          />
        )}
        {recentError && <p className="start-inline-error" role="alert">{recentError}</p>}

        <footer className="start-footer">
          <span className="local-runtime">
            Runs locally in your browser
            {offlineLabel ? (
              <span className="offline-readiness" role="status">
                {` · ${offlineLabel}`}
              </span>
            ) : null}
          </span>
          <span className="start-footer-links">
            <a className="start-credit" href="https://esauengineering.com/" target="_blank" rel="noreferrer">
              Built by Esau Engineering
            </a>
            <span aria-hidden="true"> · </span>
            <a className="start-github" href="https://github.com/esaueng/OpenFEA" target="_blank" rel="noreferrer">GitHub</a>
          </span>
        </footer>
      </div>
    </main>
  );
}

/** The start screen's sentence-case names; the Model panel keeps its compact labels. */
const START_ANALYSIS_LABELS: Record<SampleAnalysisType, string> = {
  static_stress: "Static stress",
  dynamic_structural: "Dynamic",
  modal_analysis: "Modal",
  steady_state_thermal: "Thermal"
};

interface StartSamplesSectionProps {
  analysisType: SampleAnalysisType;
  disabled?: boolean;
  onSelectAnalysisType: (analysisType: SampleAnalysisType) => void;
  onLoadSample: (sample: SampleModelId) => void;
}

/** Inline sample gallery. It replaced the second "sample menu" page: one click on a
 *  card opens that sample with the chosen analysis type (plan 035, increment 5). */
export function StartSamplesSection({ analysisType, disabled = false, onSelectAnalysisType, onLoadSample }: StartSamplesSectionProps) {
  return (
    <section className="start-samples" aria-labelledby="start-samples-title">
      <div className="start-section-header">
        <h2 id="start-samples-title">Samples</h2>
        <div className="segmented start-analysis-type" role="group" aria-label="Analysis type">
          {SAMPLE_ANALYSIS_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={analysisType === option.id ? "active" : ""}
              type="button"
              aria-pressed={analysisType === option.id}
              onClick={() => onSelectAnalysisType(option.id)}
            >
              {START_ANALYSIS_LABELS[option.id]}
            </button>
          ))}
        </div>
      </div>
      <div className="sample-option-grid start-sample-grid" role="group" aria-label="Sample models">
        {SAMPLE_OPTIONS.map((option) => (
          <SampleOptionCard
            key={option.id}
            option={option}
            selected={false}
            analysisType={analysisType}
            openOnClick
            disabled={disabled}
            onSelect={onLoadSample}
            onOpen={onLoadSample}
          />
        ))}
      </div>
    </section>
  );
}

export function RecentProjectsSection({
  entries,
  busyId,
  onOpen,
  onRemove,
  onClear
}: {
  entries: RecentProjectEntry[];
  busyId: string | null;
  onOpen: (entry: RecentProjectEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section className="recent-projects" aria-labelledby="recent-projects-title">
      <div className="start-section-header recent-projects-header">
        <h2 id="recent-projects-title">Recent</h2>
        {entries.length > 0 && <button type="button" onClick={onClear}>Clear list</button>}
      </div>
      {entries.length === 0 ? <p className="recent-projects-empty">Projects you save or open appear here.</p> : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              <span><strong>{entry.projectName}</strong><small>{entry.filename}</small></span>
              <button type="button" disabled={busyId !== null} onClick={() => onOpen(entry)}>{busyId === entry.id ? "Opening…" : "Open"}</button>
              <button type="button" aria-label={`Remove ${entry.projectName} from Recent`} disabled={busyId !== null} onClick={() => onRemove(entry.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
