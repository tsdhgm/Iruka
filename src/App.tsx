import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import type { MemoryCheck, RdpConnectParams } from "./rdp";
import { drawThumb, type SessionCallbacks, type SessionHandle, type SessionInfo } from "./session";
import { createPtySession } from "./ptySession";
import { applyPixelSize, createRdpSession } from "./rdpSession";
import { useWindowViewToggleKey } from "./hostKey";
import { ActivityBadge } from "./components/ActivityBadge";
import { ConnectWarningModal, type ConnectWarning } from "./components/ConnectWarning";
import { GridView, GRID_MAX_COLS, useMainAreaWidth } from "./components/GridView";
import { RdpForm } from "./components/RdpForm";
import { ViewToolbar } from "./components/ViewToolbar";

const THUMB_W = 196;
const THUMB_H = 110;
const ZOOM_W = 560;
const ZOOM_H = 330;

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showThumbs, setShowThumbs] = useState<boolean>(
    () => localStorage.getItem("iruka.showThumbs") !== "0",
  );
  const handlesRef = useRef<Map<number, SessionHandle>>(new Map());
  const mainRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  const thumbsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const dirtyRef = useRef<Set<number>>(new Set());
  const [zoom, setZoom] = useState<{ id: number; top: number } | null>(null);
  const zoomRef = useRef<{ id: number; top: number } | null>(null);
  zoomRef.current = zoom;
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showRdpForm, setShowRdpForm] = useState(false);
  // Pre-connect confirmation (connecting to this machine, not enough free memory); holds the pending connection.
  const [connectWarning, setConnectWarning] = useState<ConnectWarning | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarPinned, setToolbarPinned] = useState(false);
  // Right pane: one session shown large (single) or all sessions as tiles (grid).
  const [view, setView] = useState<"single" | "grid">("single");
  const viewRef = useRef<"single" | "grid">("single");
  viewRef.current = view;
  const [gridCols, setGridCols] = useState<number>(() => {
    const n = Number(localStorage.getItem("iruka.gridCols"));
    return n >= 1 && n <= GRID_MAX_COLS ? n : 3;
  });
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const gridCanvasRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // When each session last produced output (console) or a screen update (RDP); used for the running/idle badge.
  const lastActivityRef = useRef<Map<number, number>>(new Map());
  // Counter that periodically re-renders the idle-time display.
  const [, setTick] = useState(0);

  const drawZoom = useCallback(() => {
    const z = zoomRef.current;
    const canvas = zoomCanvasRef.current;
    if (!z || !canvas) return;
    const handle = handlesRef.current.get(z.id);
    if (handle) drawThumb(handle, canvas, ZOOM_W, ZOOM_H);
  }, []);

  const showSession = useCallback((id: number) => {
    const grid = viewRef.current === "grid";
    for (const [sid, handle] of handlesRef.current) {
      handle.container.style.display = !grid && sid === id ? "" : "none";
    }
    if (grid) {
      // No RDP session is shown in the grid, so do not bring remote copies into the local clipboard.
      invoke("rdp_set_active", { id: null }).catch(() => {});
      return;
    }
    const handle = handlesRef.current.get(id);
    if (handle) {
      requestAnimationFrame(() => {
        if (handle.kind === "pty") {
          handle.fit.fit();
          handle.term.focus();
          // While something other than RDP is shown, do not bring remote copies into the local clipboard.
          invoke("rdp_set_active", { id: null }).catch(() => {});
        } else {
          handle.canvas.focus();
        }
      });
    }
  }, []);

  const focusSession = useCallback(
    (id: number) => {
      setActiveId(id);
      showSession(id);
    },
    [showSession],
  );

  const updateSession = useCallback(
    (id: number, patch: Partial<SessionInfo>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  /** Toggle between the grid and the single-session view (fullscreen state is kept). */
  const toggleView = useCallback(() => {
    setView((v) => (v === "grid" ? "single" : "grid"));
  }, []);
  const toggleViewRef = useRef(toggleView);
  toggleViewRef.current = toggleView;

  // What a running session needs from the app (see SessionCallbacks).
  const sessionCallbacks = useRef<SessionCallbacks>({
    toggleView: () => toggleViewRef.current(),
    markDirty: (id) => dirtyRef.current.add(id),
    markActivity: (id) => lastActivityRef.current.set(id, Date.now()),
    updateSession: (id, patch) => updateSession(id, patch),
  }).current;

  const openConsole = useCallback(
    async () => {
      const main = mainRef.current;
      if (!main) return;
      const created = await createPtySession(main, sessionCallbacks);
      if (!created) return;
      const { id, handle } = created;
      const title = `console ${id + 1}`;

      handlesRef.current.set(id, handle);
      dirtyRef.current.add(id);
      setSessions((prev) => [
        ...prev,
        {
          id,
          kind: "pty",
          title,
          status: "running",
          exitCode: null,
          message: null,
        },
      ]);
      focusSession(id);
    },
    [focusSession, sessionCallbacks],
  );

  const openRdp = useCallback(
    async (params: RdpConnectParams) => {
      const main = mainRef.current;
      if (!main) return;
      const created = await createRdpSession(main, params, sessionCallbacks);
      if (!created) return;
      const { id, handle } = created;

      handlesRef.current.set(id, handle);
      dirtyRef.current.add(id);
      setSessions((prev) => [
        ...prev,
        {
          id,
          kind: "rdp",
          title: params.host,
          status: "connecting",
          exitCode: null,
          message: null,
        },
      ]);
      focusSession(id);
    },
    [focusSession, sessionCallbacks],
  );

  /**
   * Run the pre-connect checks, then connect. When a check stops the connection, the
   * dialog's "Connect anyway" calls this again with that check skipped. Every check is
   * best-effort: if it cannot be performed, the connection still goes ahead.
   */
  const connectWithChecks = useCallback(
    async (params: RdpConnectParams, skip: { self?: boolean; memory?: boolean }) => {
      if (!skip.self) {
        try {
          if (await invoke<boolean>("rdp_is_self", { host: params.host, port: params.port })) {
            setConnectWarning({ kind: "self", params });
            return;
          }
        } catch {
          // If it cannot be determined, continue without the confirmation.
        }
      }
      if (!skip.memory) {
        try {
          const check = await invoke<MemoryCheck>("rdp_memory_check", {
            width: params.width,
            height: params.height,
          });
          if (check.availableBytes < check.estimatedBytes) {
            setConnectWarning({ kind: "memory", params, check });
            return;
          }
        } catch {
          // Still allow connecting when the check cannot be performed.
        }
      }
      openRdp(params);
    },
    [openRdp],
  );

  const submitRdpForm = useCallback(
    (params: RdpConnectParams) => {
      setShowRdpForm(false);
      connectWithChecks(params, {});
    },
    [connectWithChecks],
  );

  const proceedDespiteWarning = useCallback(
    (warning: ConnectWarning) => {
      if (warning.kind === "self") {
        const { params } = warning;
        setConnectWarning(null);
        connectWithChecks(params, { self: true });
      } else {
        openRdp(warning.params);
        setConnectWarning(null);
      }
    },
    [connectWithChecks, openRdp],
  );

  const toggleFullscreen = useCallback(async (on: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(on);
      setFullscreen(on);
    } catch (e) {
      alert(`Could not toggle fullscreen: ${e}`);
    }
    const id = activeIdRef.current;
    if (id !== null) showSession(id);
  }, [showSession]);

  const closeSession = useCallback((id: number) => {
    if (activeIdRef.current === id) toggleFullscreen(false);
    const handle = handlesRef.current.get(id);
    if (handle) {
      if (handle.kind === "pty") {
        invoke("kill_session", { id }).catch(() => {});
        handle.term.dispose();
      } else {
        invoke("rdp_close", { id }).catch(() => {});
      }
      handle.container.remove();
      handlesRef.current.delete(id);
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeIdRef.current === id) {
        const fallback = next.length > 0 ? next[next.length - 1].id : null;
        setActiveId(fallback);
        if (fallback !== null) {
          showSession(fallback);
        }
      }
      return next;
    });
  }, [showSession, toggleFullscreen]);

  // Every 500ms, redraw the thumbnails (sidebar and grid tiles) of sessions that had output.
  useEffect(() => {
    const iv = setInterval(() => {
      for (const id of dirtyRef.current) {
        const handle = handlesRef.current.get(id);
        const canvas = thumbsRef.current.get(id);
        if (handle && canvas) {
          drawThumb(handle, canvas, THUMB_W, THUMB_H);
        }
        const tile = gridCanvasRef.current.get(id);
        if (handle && tile) {
          drawThumb(handle, tile, tile.clientWidth, tile.clientHeight);
        }
        dirtyRef.current.delete(id);
      }
      drawZoom();
      setTick((t) => t + 1);
    }, 500);
    return () => clearInterval(iv);
  }, [drawZoom]);

  // When the grid view is toggled: update which session is shown and draw every tile.
  useEffect(() => {
    const id = activeIdRef.current;
    if (id !== null) showSession(id);
    if (view === "grid") {
      for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
    }
  }, [view, showSession]);

  // Width of the right pane (used to compute the tile size).
  const markAllDirty = useCallback(() => {
    for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
  }, []);
  const mainWidth = useMainAreaWidth(mainAreaRef, markAllDirty);

  // View-toggle key while no session has focus (e.g. in the grid view).
  useWindowViewToggleKey(toggleViewRef);

  const changeGridCols = useCallback((cols: number) => {
    setGridCols(cols);
    localStorage.setItem("iruka.gridCols", String(cols));
    for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
  }, []);

  useEffect(() => {
    drawZoom();
  }, [zoom, drawZoom]);

  useEffect(() => {
    const onWindowResize = () => {
      const id = activeIdRef.current;
      if (id === null) return;
      const handle = handlesRef.current.get(id);
      if (handle?.kind === "pty") handle.fit.fit();
      // If the display scale changed (e.g. the window moved to another monitor), re-apply the 1:1 size.
      for (const h of handlesRef.current.values()) {
        if (h.kind === "rdp") applyPixelSize(h.canvas);
      }
      // Also follow along when the window manager left fullscreen on its own.
      getCurrentWindow()
        .isFullscreen()
        .then(setFullscreen)
        .catch(() => {});
    };
    // After copying in another app and coming back, hand the clipboard to the RDP session being shown.
    const onWindowFocus = () => {
      const id = activeIdRef.current;
      if (id !== null && handlesRef.current.get(id)?.kind === "rdp") {
        invoke("rdp_set_active", { id }).catch(() => {});
      }
    };
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className={`app ${fullscreen ? "fullscreen" : ""}`}>
      <aside className="sidebar">
        <div className="brand">🐬 Iruka</div>
        <div className="connect-form">
          <button className="new-console-btn" onClick={() => openConsole()}>
            + Console
          </button>
          <button
            className="new-console-btn"
            onClick={() => setShowRdpForm((f) => !f)}
          >
            + RDP
          </button>
          <button
            className="thumb-toggle"
            title={
              showThumbs ? "Show names only" : "Show thumbnails"
            }
            onClick={() =>
              setShowThumbs((v) => {
                const next = !v;
                localStorage.setItem("iruka.showThumbs", next ? "1" : "0");
                return next;
              })
            }
          >
            {showThumbs ? "☰" : "🖼"}
          </button>
        </div>
        {showRdpForm && (
          <RdpForm onConnect={submitRdpForm} onCancel={() => setShowRdpForm(false)} />
        )}
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-card ${s.id === activeId ? "active" : ""}`}
              onClick={() => focusSession(s.id)}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const top = Math.max(
                  8,
                  Math.min(rect.top, window.innerHeight - ZOOM_H - 8),
                );
                setZoom({ id: s.id, top });
              }}
              onMouseLeave={() => setZoom(null)}
            >
              <div className="session-card-header">
                <span className={`status-dot ${s.status}`} />
                <span className="session-kind">
                  {s.kind === "rdp" ? "RDP" : ">_"}
                </span>
                <span className="session-title" title={s.message ?? undefined}>
                  {s.title}
                </span>
                <ActivityBadge session={s} lastActivity={lastActivityRef.current.get(s.id)} />
                <button
                  className="close-btn"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoom(null);
                    closeSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
              {showThumbs && (
                <canvas
                  className="thumb"
                  ref={(el) => {
                    if (el) {
                      thumbsRef.current.set(s.id, el);
                      dirtyRef.current.add(s.id);
                    } else {
                      thumbsRef.current.delete(s.id);
                    }
                  }}
                />
              )}
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="empty-hint">
              No sessions yet.
              <br />
              Open one with "+ Console" or "+ RDP".
            </div>
          )}
        </div>
      </aside>
      <div className="main-area" ref={mainAreaRef}>
        <main className="main" ref={mainRef}>
          {sessions.length === 0 && (
            <div className="placeholder">
              <div className="placeholder-logo">🐬</div>
              <p>Iruka — console &amp; desktop fleet viewer</p>
            </div>
          )}
        </main>
        {view === "grid" && (
          <GridView
            sessions={sessions}
            activeId={activeId}
            gridCols={gridCols}
            mainWidth={mainWidth}
            gridCanvasRef={gridCanvasRef}
            dirtyRef={dirtyRef}
            lastActivityRef={lastActivityRef}
            onSelect={(id) => {
              setView("single");
              focusSession(id);
            }}
          />
        )}
        {sessions.length > 0 && (
          <ViewToolbar
            view={view}
            sessionCount={sessions.length}
            activeSession={activeSession}
            gridCols={gridCols}
            pinned={toolbarPinned}
            fullscreen={fullscreen}
            onToggleView={toggleView}
            onChangeGridCols={changeGridCols}
            onTogglePinned={() => setToolbarPinned((v) => !v)}
            onToggleFullscreen={toggleFullscreen}
            onClose={closeSession}
          />
        )}
      </div>
      {connectWarning && (
        <ConnectWarningModal
          warning={connectWarning}
          onCancel={() => setConnectWarning(null)}
          onProceed={proceedDespiteWarning}
        />
      )}
      {zoom !== null && (
        <div className="zoom-overlay" style={{ top: zoom.top }}>
          <canvas ref={zoomCanvasRef} className="zoom-canvas" />
        </div>
      )}
    </div>
  );
}

export default App;
