import { useEffect, useRef, useState, type RefObject } from "react";
import type { SessionInfo } from "../session";
import { ActivityBadge } from "./ActivityBadge";

/** Maximum number of grid columns, and the tile padding / gap (px). */
export const GRID_MAX_COLS = 6;
const GRID_PAD = 8;
const GRID_GAP = 8;
/** Key of the local-desktop tile among the tile elements (session ids are positive). */
const LOCAL_TILE = -1;

/**
 * Tracks the width of the main (right) pane, which the tile size is computed from.
 * `onResize` is called on every size change so the tiles can be redrawn.
 */
export function useMainAreaWidth(
  ref: RefObject<HTMLDivElement | null>,
  onResize: () => void,
): number {
  const [mainWidth, setMainWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setMainWidth(entry.contentRect.width);
      // A width change also changes the tile size, so redraw.
      onResize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return mainWidth;
}

/** Grid: all sessions as 16:9 tiles. Vertical overflow scrolls. */
export function GridView({
  sessions,
  activeId,
  gridCols,
  mainWidth,
  gridCanvasRef,
  dirtyRef,
  lastActivityRef,
  onSelect,
  onSelectLocal,
  onReconnect,
}: {
  sessions: SessionInfo[];
  activeId: number | null;
  gridCols: number;
  mainWidth: number;
  gridCanvasRef: RefObject<Map<number, HTMLCanvasElement>>;
  dirtyRef: RefObject<Set<number>>;
  lastActivityRef: RefObject<Map<number, number>>;
  onSelect: (id: number) => void;
  /** Called when the "Local desktop" tile (always the last one) is chosen. */
  onSelectLocal: () => void;
  /** Connect an ended RDP session again (the button on its tile). */
  onReconnect: (id: number) => void;
}) {
  // Keyboard selection: the tile that Enter would open. Starts on the active session.
  const [focused, setFocused] = useState(() => {
    const i = sessions.findIndex((s) => s.id === activeId);
    return i < 0 ? 0 : i;
  });
  const tileRefs = useRef(new Map<number, HTMLDivElement>());

  // Keep the index valid when sessions come and go.
  // Session i is tile i; the local desktop is the last tile.
  const count = sessions.length + 1;
  useEffect(() => {
    setFocused((i) => Math.min(i, count - 1));
  }, [count]);

  // Arrow keys and Tab / Shift+Tab move the selection, Enter opens it. Ignored while typing in a form field.
  const latest = useRef({ sessions, gridCols, focused, onSelect, onSelectLocal });
  latest.current = { sessions, gridCols, focused, onSelect, onSelectLocal };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const { sessions, gridCols, focused, onSelect, onSelectLocal } = latest.current;
      const n = sessions.length + 1;
      let next = focused;
      // Shift+Tab may arrive as "ISO_Left_Tab" rather than "Tab" (WebKitGTK), so go by the
      // physical key for Tab.
      switch (e.code === "Tab" ? "Tab" : e.key) {
        case "ArrowLeft":
          next = Math.max(0, focused - 1);
          break;
        case "ArrowRight":
          next = Math.min(n - 1, focused + 1);
          break;
        case "ArrowUp":
          next = focused - gridCols >= 0 ? focused - gridCols : focused;
          break;
        case "ArrowDown":
          next = focused + gridCols < n ? focused + gridCols : focused;
          break;
        case "Tab":
          // Tab cycles forward, Shift+Tab backward, wrapping around at the ends.
          next = (focused + (e.shiftKey ? n - 1 : 1)) % n;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = n - 1;
          break;
        case "Enter":
          e.preventDefault();
          if (focused === sessions.length) onSelectLocal();
          else onSelect(sessions[focused].id);
          return;
        default:
          return;
      }
      e.preventDefault();
      setFocused(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the selected tile visible when it moves off screen.
  useEffect(() => {
    const key = focused === sessions.length ? LOCAL_TILE : sessions[focused]?.id;
    if (key !== undefined) tileRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [focused, sessions]);

  // Tiles are 16:9. Divide the main pane width by the column count (minus padding and gaps).
  const tileW = Math.max(
    80,
    Math.floor((mainWidth - GRID_PAD * 2 - GRID_GAP * (gridCols - 1)) / gridCols),
  );
  const tileH = Math.round((tileW * 9) / 16);

  return (
    <div
      className="grid-view"
      style={{
        gridTemplateColumns: `repeat(${gridCols}, ${tileW}px)`,
        padding: GRID_PAD,
        gap: GRID_GAP,
      }}
    >
      {sessions.map((s, i) => (
        <div
          key={s.id}
          className={`grid-tile ${s.id === activeId ? "active" : ""} ${i === focused ? "focused" : ""} ${
            s.kind === "rdp" && s.status === "exited" ? "disconnected" : ""
          }`}
          title="Click to show on its own (or select with the arrow keys or Tab and press Enter)"
          onClick={() => onSelect(s.id)}
          ref={(el) => {
            if (el) tileRefs.current.set(s.id, el);
            else tileRefs.current.delete(s.id);
          }}
        >
          <div className="grid-tile-header">
            <span className={`status-dot ${s.status}`} />
            <span className="session-kind">{s.kind === "rdp" ? "RDP" : ">_"}</span>
            <span className="session-title">{s.title}</span>
            <ActivityBadge session={s} lastActivity={lastActivityRef.current.get(s.id)} />
            {s.kind === "rdp" && s.status === "exited" && (
              <button
                className="reconnect-btn"
                title="Connect again"
                onClick={(e) => {
                  e.stopPropagation();
                  onReconnect(s.id);
                }}
              >
                Reconnect
              </button>
            )}
          </div>
          <canvas
            style={{ width: tileW, height: tileH }}
            ref={(el) => {
              if (el) {
                gridCanvasRef.current.set(s.id, el);
                dirtyRef.current.add(s.id);
              } else {
                gridCanvasRef.current.delete(s.id);
              }
            }}
          />
        </div>
      ))}
      <div
        className={`grid-tile ${focused === sessions.length ? "focused" : ""}`}
        title="Click to use this computer's own desktop: Iruka steps aside (minimizes) and comes back as it was"
        onClick={onSelectLocal}
        ref={(el) => {
          if (el) tileRefs.current.set(LOCAL_TILE, el);
          else tileRefs.current.delete(LOCAL_TILE);
        }}
      >
        <div className="grid-tile-header">
          <span className="session-kind">LOCAL</span>
          <span className="session-title">Local desktop</span>
        </div>
        <div className="grid-tile-local" style={{ width: tileW, height: tileH }}>
          <div className="grid-tile-local-icon">🖥</div>
          <div>This computer</div>
        </div>
      </div>
    </div>
  );
}
