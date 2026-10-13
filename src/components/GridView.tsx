import { useEffect, useState, type RefObject } from "react";
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
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`grid-tile ${s.id === activeId ? "active" : ""}`}
          title="Click to show on its own"
          onClick={() => onSelect(s.id)}
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
