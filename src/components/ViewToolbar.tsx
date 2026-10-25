import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VIEW_TOGGLE_LABEL } from "../hostKey";
import type { SessionInfo } from "../session";
import { GRID_MAX_COLS } from "./GridView";

type MemoryStatus = { usedBytes: number; totalBytes: number; sessionBytes: number | null };

/** Refresh interval of the memory figures (the backend samples every 3 s). */
const MEMORY_POLL_MS = 3000;

const formatGb = (bytes: number) => `${(bytes / 1073741824).toFixed(1)} GB`;

/** Memory figures from the backend, refreshed while the toolbar exists. */
function useMemoryStatus(id: number | null): MemoryStatus | null {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      invoke<MemoryStatus>("memory_status", { id }).then(
        (s) => alive && setStatus(s),
        () => {},
      );
    poll();
    const timer = setInterval(poll, MEMORY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  return status;
}

/** "#3 ≈1.4 GB / Iruka 7.0 GB / RAM 31.8 GB"; the session part is an estimate and RDP only. */
function MemoryReadout({ session }: { session: SessionInfo | null }) {
  const status = useMemoryStatus(session?.id ?? null);
  if (!status || status.usedBytes === 0) return null;
  const sessionPart = session
    ? `#${session.id}${status.sessionBytes !== null ? ` ≈${formatGb(status.sessionBytes)}` : ""} / `
    : "";
  return (
    <span
      className="view-toolbar-memory"
      title={
        "Selected session (RDP: estimated share, all sessions share one process) / " +
        "Iruka as a whole incl. WebView / physical memory"
      }
    >
      {`${sessionPart}Iruka ${formatGb(status.usedBytes)} / RAM ${formatGb(status.totalBytes)}`}
    </span>
  );
}

/** Remmina-style toolbar: it drops down when the mouse touches the tab at the top center. */
export function ViewToolbar({
  view,
  sessionCount,
  activeSession,
  gridCols,
  pinned,
  fullscreen,
  scaled,
  onToggleView,
  onChangeGridCols,
  onTogglePinned,
  onToggleFullscreen,
  onToggleScaled,
  onPrintScreen,
  onClose,
}: {
  view: "single" | "grid";
  sessionCount: number;
  activeSession: SessionInfo | null;
  gridCols: number;
  pinned: boolean;
  fullscreen: boolean;
  /** RDP screens fitted into the view instead of 1:1 (all sessions). */
  scaled: boolean;
  onToggleView: () => void;
  onChangeGridCols: (cols: number) => void;
  onTogglePinned: () => void;
  onToggleFullscreen: (on: boolean) => void;
  onToggleScaled: (on: boolean) => void;
  /** Send a Print Screen key press to this RDP session (the local desktop takes the key itself). */
  onPrintScreen: (id: number) => void;
  onClose: (id: number) => void;
}) {
  return (
    <div className={`view-toolbar ${pinned ? "pinned" : ""}`}>
      <div className="view-toolbar-body">
        {/* Leftmost, away from the other buttons, so it is not hit by accident */}
        {view === "single" && activeSession?.kind === "rdp" && (
          <button
            className="view-toolbar-print"
            title="Send Print Screen to the remote (the local desktop keeps the key itself); the screenshot lands in the remote's clipboard"
            onClick={() => onPrintScreen(activeSession.id)}
          >
            ⎙
          </button>
        )}
        <span className="view-toolbar-title">
          {view === "grid" ? `Grid (${sessionCount})` : activeSession?.title}
        </span>
        <MemoryReadout session={activeSession} />
        <button
          className={view === "grid" ? "on" : ""}
          title={`${view === "grid" ? "Single view" : "Grid view"} (${VIEW_TOGGLE_LABEL})`}
          onClick={onToggleView}
        >
          {view === "grid" ? "▣" : "⊞"}
        </button>
        {view === "grid" && (
          <label className="view-toolbar-slider" title={`Columns: ${gridCols}`}>
            <span>🔍</span>
            <input
              type="range"
              min={1}
              max={GRID_MAX_COLS}
              value={gridCols}
              onChange={(e) => onChangeGridCols(Number(e.target.value))}
            />
            <span className="view-toolbar-cols">{gridCols} cols</span>
          </label>
        )}
        <button
          className={pinned ? "on" : ""}
          title={pinned ? "Unpin toolbar" : "Keep toolbar open"}
          onClick={onTogglePinned}
        >
          📌
        </button>
        <button
          className={scaled ? "on" : ""}
          title={scaled ? "Scaled: the whole remote screen fitted into the view (click for 1:1)" : "Scaled: fit the whole remote screen into the view"}
          onClick={() => onToggleScaled(!scaled)}
        >
          {scaled ? "1:1" : "⤢"}
        </button>
        <button
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => onToggleFullscreen(!fullscreen)}
        >
          {fullscreen ? "🗗" : "⛶"}
        </button>
        {view === "single" && activeSession && (
          <button
            className="danger"
            title={activeSession.kind === "rdp" ? "Disconnect" : "Close console"}
            onClick={() => onClose(activeSession.id)}
          >
            ×
          </button>
        )}
      </div>
      <div className="view-toolbar-handle" />
    </div>
  );
}
