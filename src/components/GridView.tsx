import { useEffect, useRef, useState, type RefObject } from "react";
import type { SessionInfo } from "../session";
import { ActivityBadge } from "./ActivityBadge";

/** Maximum number of grid columns, and the tile padding / gap (px). */
export const GRID_MAX_COLS = 6;
const GRID_PAD = 8;
const GRID_GAP = 8;

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
}: {
  sessions: SessionInfo[];
  activeId: number | null;
  gridCols: number;
  mainWidth: number;
  gridCanvasRef: RefObject<Map<number, HTMLCanvasElement>>;
  dirtyRef: RefObject<Set<number>>;
  lastActivityRef: RefObject<Map<number, number>>;
  onSelect: (id: number) => void;
}) {
  // Keyboard selection: the tile that Enter would open. Starts on the active session.
  const [focused, setFocused] = useState(() => {
    const i = sessions.findIndex((s) => s.id === activeId);
    return i < 0 ? 0 : i;
  });
  const tileRefs = useRef(new Map<number, HTMLDivElement>());

  // Keep the index valid when sessions come and go.
  const count = sessions.length;
  useEffect(() => {
    setFocused((i) => (count === 0 ? 0 : Math.min(i, count - 1)));
  }, [count]);

  // Arrow keys and Tab / Shift+Tab move the selection, Enter opens it. Ignored while typing in a form field.
  const latest = useRef({ sessions, gridCols, focused, onSelect });
  latest.current = { sessions, gridCols, focused, onSelect };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const { sessions, gridCols, focused, onSelect } = latest.current;
      const n = sessions.length;
      if (n === 0) return;
      let next = focused;
      switch (e.key) {
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
          onSelect(sessions[focused].id);
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
    const s = sessions[focused];
    if (s) tileRefs.current.get(s.id)?.scrollIntoView({ block: "nearest" });
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
          className={`grid-tile ${s.id === activeId ? "active" : ""} ${i === focused ? "focused" : ""}`}
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
    </div>
  );
}
