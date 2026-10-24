import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { drawCanvasToCanvas } from "./rdp";

export type SessionStatus = "connecting" | "running" | "exited";

export interface SessionInfo {
  id: number;
  kind: "pty" | "rdp";
  /** The saved connection this session came from; plain consoles have none. */
  profileId?: string;
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  message: string | null;
}

export type SessionHandle =
  | { kind: "pty"; term: Terminal; fit: FitAddon; container: HTMLDivElement }
  | { kind: "rdp"; canvas: HTMLCanvasElement; container: HTMLDivElement };

/**
 * Hooks a session needs to report back to the app while it is running.
 * All of them are safe to call from channel callbacks and DOM listeners.
 */
export interface SessionCallbacks {
  /** Toggle between the grid and the single-session view (the host key). */
  toggleView: () => void;
  /** Mark the session's thumbnails as needing a redraw. */
  markDirty: (id: number) => void;
  /** Record that the session produced output / a screen update just now. */
  markActivity: (id: number) => void;
  /** Patch the session's entry in the session list. */
  updateSession: (id: number, patch: Partial<SessionInfo>) => void;
}

export function drawThumb(
  handle: SessionHandle,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
) {
  if (handle.kind === "pty") drawTermToCanvas(handle.term, canvas, cssW, cssH);
  else drawCanvasToCanvas(handle.canvas, canvas, cssW, cssH);
}

function drawTermToCanvas(
  term: Terminal,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
) {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#11151c";
  ctx.fillRect(0, 0, cssW, cssH);

  const buf = term.buffer.active;
  const rows = term.rows;
  const lineH = cssH / rows;
  const fontSize = Math.max(2, lineH * 0.85);
  ctx.font = `${fontSize}px monospace`;
  ctx.textBaseline = "top";

  ctx.fillStyle = "#20344d";
  ctx.fillRect(0, buf.cursorY * lineH, cssW, lineH);

  ctx.fillStyle = "#9fb2c8";
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text) ctx.fillText(text, 3, i * lineH + (lineH - fontSize) / 2);
  }
}
