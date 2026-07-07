import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null };

type SessionStatus = "running" | "exited";

interface SessionInfo {
  id: number;
  title: string;
  status: SessionStatus;
  exitCode: number | null;
}

interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const TERM_THEME = {
  background: "#11151c",
  foreground: "#d6dde8",
  cursor: "#7fd1e8",
  selectionBackground: "#2b3a4d",
};

const THUMB_W = 196;
const THUMB_H = 110;
const ZOOM_W = 560;
const ZOOM_H = 330;

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

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showThumbs, setShowThumbs] = useState<boolean>(
    () => localStorage.getItem("iruka.showThumbs") !== "0",
  );
  const terminalsRef = useRef<Map<number, TermHandle>>(new Map());
  const mainRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  const thumbsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const dirtyRef = useRef<Set<number>>(new Set());
  const [zoom, setZoom] = useState<{ id: number; top: number } | null>(null);
  const zoomRef = useRef<{ id: number; top: number } | null>(null);
  zoomRef.current = zoom;
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);

  const drawZoom = useCallback(() => {
    const z = zoomRef.current;
    const canvas = zoomCanvasRef.current;
    if (!z || !canvas) return;
    const handle = terminalsRef.current.get(z.id);
    if (handle) drawTermToCanvas(handle.term, canvas, ZOOM_W, ZOOM_H);
  }, []);

  const focusSession = useCallback((id: number) => {
    for (const [sid, handle] of terminalsRef.current) {
      handle.container.style.display = sid === id ? "block" : "none";
    }
    setActiveId(id);
    const handle = terminalsRef.current.get(id);
    if (handle) {
      requestAnimationFrame(() => {
        handle.fit.fit();
        handle.term.focus();
      });
    }
  }, []);

  const openConsole = useCallback(
    async () => {
      const main = mainRef.current;
      if (!main) return;

      const container = document.createElement("div");
      container.className = "term-container";
      main.appendChild(container);

      const term = new Terminal({
        fontFamily: "'JetBrains Mono', 'Noto Sans Mono', monospace",
        fontSize: 14,
        theme: TERM_THEME,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();

      const onEvent = new Channel<PtyEvent>();
      let id: number;
      try {
        id = await invoke<number>("spawn_session", {
          program: null,
          args: [],
          cols: term.cols,
          rows: term.rows,
          onEvent,
        });
      } catch (e) {
        term.dispose();
        container.remove();
        alert(`コンソールの起動に失敗しました: ${e}`);
        return;
      }
      const title = `console ${id + 1}`;

      onEvent.onmessage = (msg) => {
        dirtyRef.current.add(id);
        if (msg.type === "output") {
          term.write(b64ToBytes(msg.data));
        } else {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === id ? { ...s, status: "exited", exitCode: msg.code } : s,
            ),
          );
          term.write(
            `\r\n\x1b[90m[セッション終了 (exit ${msg.code ?? "?"})]\x1b[0m\r\n`,
          );
        }
      };

      term.onData((data) => {
        invoke("write_session", { id, data }).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        invoke("resize_session", { id, cols, rows }).catch(() => {});
      });

      terminalsRef.current.set(id, { term, fit, container });
      dirtyRef.current.add(id);
      setSessions((prev) => [
        ...prev,
        { id, title, status: "running", exitCode: null },
      ]);
      focusSession(id);
    },
    [focusSession],
  );

  const closeSession = useCallback((id: number) => {
    invoke("kill_session", { id }).catch(() => {});
    const handle = terminalsRef.current.get(id);
    if (handle) {
      handle.term.dispose();
      handle.container.remove();
      terminalsRef.current.delete(id);
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeIdRef.current === id) {
        const fallback = next.length > 0 ? next[next.length - 1].id : null;
        setActiveId(fallback);
        if (fallback !== null) {
          requestAnimationFrame(() => {
            const h = terminalsRef.current.get(fallback);
            if (h) {
              h.container.style.display = "block";
              h.fit.fit();
              h.term.focus();
            }
          });
        }
      }
      return next;
    });
  }, []);

  // 500ms ごとに、出力のあったセッションのサムネールだけ再描画する
  useEffect(() => {
    const iv = setInterval(() => {
      for (const id of dirtyRef.current) {
        const handle = terminalsRef.current.get(id);
        const canvas = thumbsRef.current.get(id);
        if (handle && canvas) {
          drawTermToCanvas(handle.term, canvas, THUMB_W, THUMB_H);
        }
        dirtyRef.current.delete(id);
      }
      drawZoom();
    }, 500);
    return () => clearInterval(iv);
  }, [drawZoom]);

  useEffect(() => {
    drawZoom();
  }, [zoom, drawZoom]);

  useEffect(() => {
    const onWindowResize = () => {
      const id = activeIdRef.current;
      if (id === null) return;
      const handle = terminalsRef.current.get(id);
      if (handle) handle.fit.fit();
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">🐬 Iruka</div>
        <div className="connect-form">
          <button className="new-console-btn" onClick={() => openConsole()}>
            ＋ 新しいコンソール
          </button>
          <button
            className="thumb-toggle"
            title={
              showThumbs ? "名前のみ表示に切り替え" : "サムネール表示に切り替え"
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
                <span className="session-title">{s.title}</span>
                <button
                  className="close-btn"
                  title="閉じる"
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
              コンソールがありません。
              <br />
              「＋ 新しいコンソール」で開きます。
            </div>
          )}
        </div>
      </aside>
      <main className="main" ref={mainRef}>
        {sessions.length === 0 && (
          <div className="placeholder">
            <div className="placeholder-logo">🐬</div>
            <p>Iruka — console fleet viewer</p>
          </div>
        )}
      </main>
      {zoom !== null && (
        <div className="zoom-overlay" style={{ top: zoom.top }}>
          <canvas ref={zoomCanvasRef} className="zoom-canvas" />
        </div>
      )}
    </div>
  );
}

export default App;
