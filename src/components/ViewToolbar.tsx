import { VIEW_TOGGLE_LABEL } from "../hostKey";
import type { SessionInfo } from "../session";
import { GRID_MAX_COLS } from "./GridView";

/** Remmina-style toolbar: it drops down when the mouse touches the tab at the top center. */
export function ViewToolbar({
  view,
  sessionCount,
  activeSession,
  gridCols,
  pinned,
  fullscreen,
  onToggleView,
  onChangeGridCols,
  onTogglePinned,
  onToggleFullscreen,
  onClose,
}: {
  view: "single" | "grid";
  sessionCount: number;
  activeSession: SessionInfo | null;
  gridCols: number;
  pinned: boolean;
  fullscreen: boolean;
  onToggleView: () => void;
  onChangeGridCols: (cols: number) => void;
  onTogglePinned: () => void;
  onToggleFullscreen: (on: boolean) => void;
  onClose: (id: number) => void;
}) {
  return (
    <div className={`view-toolbar ${pinned ? "pinned" : ""}`}>
      <div className="view-toolbar-body">
        <span className="view-toolbar-title">
          {view === "grid" ? `Grid (${sessionCount})` : activeSession?.title}
        </span>
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
