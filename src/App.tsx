import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import {
  drawCanvasToCanvas,
  RDP_BACKENDS,
  SCANCODES,
  toRemoteCoords,
  type RdpBackendKind,
  type RdpConnectParams,
  type RdpEvent,
  type RdpInput,
} from "./rdp";

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null };

type SessionStatus = "connecting" | "running" | "exited";

interface SessionInfo {
  id: number;
  kind: "pty" | "rdp";
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  message: string | null;
}

type SessionHandle =
  | { kind: "pty"; term: Terminal; fit: FitAddon; container: HTMLDivElement }
  | { kind: "rdp"; canvas: HTMLCanvasElement; container: HTMLDivElement };

/** リモートの 1 ピクセルを物理 1 ピクセルで表示する（OS の表示倍率を打ち消す） */
function applyPixelSize(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
}

interface RdpForm {
  host: string;
  username: string;
  password: string;
  backend: RdpBackendKind;
}

/**
 * 要求するリモート解像度 = ローカルモニタの物理解像度（mstsc の全画面接続と同じ）。
 * 全画面表示で等倍ぴったり、ウィンドウ表示でははみ出す分をスクロールで見る。
 * 画面共有型のサーバー（GNOME Remote Desktop）は自分の画面サイズを通知してくるので、
 * 実際の大きさはサーバーからの resize イベントに従う。
 */
function localDesktopSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  // RDP で要求できる範囲（200〜8192）に収め、幅は偶数にする
  const clamp = (v: number) => Math.max(200, Math.min(8192, Math.round(v)));
  return {
    width: clamp(window.screen.width * dpr) & ~1,
    height: clamp(window.screen.height * dpr),
  };
}

function loadRdpForm(): RdpForm {
  try {
    const saved = JSON.parse(localStorage.getItem("iruka.rdpForm") ?? "{}");
    return {
      host: saved.host ?? "",
      username: saved.username ?? "",
      password: "",
      backend: saved.backend ?? "auto",
    };
  } catch {
    return { host: "", username: "", password: "", backend: "auto" };
  }
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

function drawThumb(
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
  const [rdpForm, setRdpForm] = useState<RdpForm | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarPinned, setToolbarPinned] = useState(false);

  const drawZoom = useCallback(() => {
    const z = zoomRef.current;
    const canvas = zoomCanvasRef.current;
    if (!z || !canvas) return;
    const handle = handlesRef.current.get(z.id);
    if (handle) drawThumb(handle, canvas, ZOOM_W, ZOOM_H);
  }, []);

  const showSession = useCallback((id: number) => {
    for (const [sid, handle] of handlesRef.current) {
      handle.container.style.display = sid === id ? "" : "none";
    }
    const handle = handlesRef.current.get(id);
    if (handle) {
      requestAnimationFrame(() => {
        if (handle.kind === "pty") {
          handle.fit.fit();
          handle.term.focus();
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
          updateSession(id, { status: "exited", exitCode: msg.code });
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

      handlesRef.current.set(id, { kind: "pty", term, fit, container });
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
    [focusSession, updateSession],
  );

  const openRdp = useCallback(
    async (params: RdpConnectParams) => {
      const main = mainRef.current;
      if (!main) return;

      const container = document.createElement("div");
      container.className = "rdp-container";
      const scroller = document.createElement("div");
      scroller.className = "rdp-scroller";
      const canvas = document.createElement("canvas");
      canvas.className = "rdp-canvas";
      canvas.tabIndex = 0;
      canvas.width = params.width;
      canvas.height = params.height;
      const status = document.createElement("div");
      status.className = "rdp-status";
      status.textContent = `${params.host} に接続中…`;
      scroller.append(canvas);
      container.append(scroller, status);
      applyPixelSize(canvas);
      main.appendChild(container);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 性能計測（調査用）：2 秒ごとに、受信の遅れと描画にかかった時間を Rust のログへ出す
      const perf = { frames: 0, kb: 0, handleMs: 0, maxLag: 0, maxHandle: 0 };

      // 画面の中身はバイナリで届く（形式は Rust 側 FrameSink のコメント参照）
      let sid: number | null = null;
      const onFrame = new Channel<ArrayBuffer>();
      onFrame.onmessage = (buf) => {
        const t0 = performance.now();
        const view = new DataView(buf);
        const fbWidth = view.getUint32(0, true);
        const fbHeight = view.getUint32(4, true);
        const count = view.getUint32(8, true);
        const sentAt = view.getFloat64(16, true);
        // サイズ変更の前後で行き違ったデータは捨てる（作り直し後に全体が届く）
        if (fbWidth !== canvas.width || fbHeight !== canvas.height) return;
        let offset = 24;
        for (let i = 0; i < count; i++) {
          const x = view.getUint32(offset, true);
          const y = view.getUint32(offset + 4, true);
          const w = view.getUint32(offset + 8, true);
          const h = view.getUint32(offset + 12, true);
          offset += 16;
          const len = w * h * 4;
          const img = new ImageData(new Uint8ClampedArray(buf, offset, len), w, h);
          ctx.putImageData(img, x, y);
          offset += len;
        }
        if (sid !== null) dirtyRef.current.add(sid);
        const dt = performance.now() - t0;
        perf.frames++;
        perf.kb += Math.round(buf.byteLength / 1024);
        perf.handleMs += dt;
        perf.maxHandle = Math.max(perf.maxHandle, dt);
        perf.maxLag = Math.max(perf.maxLag, Date.now() - sentAt);
      };

      const onEvent = new Channel<RdpEvent>();
      let id: number;
      try {
        id = await invoke<number>("rdp_connect", { params, onEvent, onFrame });
        sid = id;
      } catch (e) {
        container.remove();
        alert(`RDP 接続を開始できませんでした: ${e}`);
        return;
      }

      const perfTimer = setInterval(() => {
        if (perf.frames === 0) return;
        invoke("rdp_perf_log", {
          message: `id=${id} frames=${perf.frames} kb=${perf.kb} handle_ms_total=${perf.handleMs.toFixed(1)} handle_ms_max=${perf.maxHandle.toFixed(1)} lag_ms_max=${perf.maxLag.toFixed(0)}`,
        }).catch(() => {});
        Object.assign(perf, { frames: 0, kb: 0, handleMs: 0, maxLag: 0, maxHandle: 0 });
      }, 2000);

      onEvent.onmessage = (msg) => {
        if (msg.type === "resize") {
          canvas.width = msg.width;
          canvas.height = msg.height;
          applyPixelSize(canvas);
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          status.style.display = "none";
          updateSession(id, { status: "running", message: null });
          dirtyRef.current.add(id);
        } else {
          clearInterval(perfTimer);
          status.style.display = "";
          status.textContent = msg.error
            ? `接続エラー（${msg.backend}）: ${msg.reason}`
            : `切断されました（${msg.backend}）: ${msg.reason}`;
          status.classList.toggle("error", msg.error);
          updateSession(id, { status: "exited", message: msg.reason });
        }
      };

      // 入力はフレームごとにまとめて送る（マウス移動は最新の 1 件だけ残す）
      let queue: RdpInput[] = [];
      let scheduled = false;
      const send = (ev: RdpInput) => {
        const last = queue[queue.length - 1];
        if (ev.type === "mouseMove" && last?.type === "mouseMove") {
          queue[queue.length - 1] = ev;
        } else {
          queue.push(ev);
        }
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const events = queue;
          queue = [];
          invoke("rdp_input", { id, events }).catch(() => {});
        });
      };

      canvas.addEventListener("pointermove", (e) => {
        send({ type: "mouseMove", ...toRemoteCoords(canvas, e.clientX, e.clientY) });
      });
      canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        canvas.focus();
        canvas.setPointerCapture(e.pointerId);
        send({ type: "mouseMove", ...toRemoteCoords(canvas, e.clientX, e.clientY) });
        send({ type: "mouseButton", button: e.button, down: true });
      });
      canvas.addEventListener("pointerup", (e) => {
        send({ type: "mouseMove", ...toRemoteCoords(canvas, e.clientX, e.clientY) });
        send({ type: "mouseButton", button: e.button, down: false });
      });
      canvas.addEventListener("contextmenu", (e) => e.preventDefault());
      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          if (e.deltaY !== 0) {
            send({ type: "wheel", vertical: true, units: e.deltaY < 0 ? 120 : -120 });
          }
          if (e.deltaX !== 0) {
            send({ type: "wheel", vertical: false, units: e.deltaX > 0 ? 120 : -120 });
          }
        },
        { passive: false },
      );
      const onKey = (down: boolean) => (e: KeyboardEvent) => {
        const scancode = SCANCODES[e.code];
        if (scancode === undefined) return;
        e.preventDefault();
        send({ type: "key", scancode, down });
      };
      canvas.addEventListener("keydown", onKey(true));
      canvas.addEventListener("keyup", onKey(false));
      canvas.addEventListener("blur", () => send({ type: "releaseAll" }));

      handlesRef.current.set(id, { kind: "rdp", canvas, container });
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
    [focusSession, updateSession],
  );

  const submitRdpForm = useCallback(() => {
    if (!rdpForm || !rdpForm.host.trim() || !rdpForm.username.trim()) return;
    const [hostPart, portPart] = rdpForm.host.trim().split(":");
    const { width, height } = localDesktopSize();
    localStorage.setItem(
      "iruka.rdpForm",
      JSON.stringify({
        host: rdpForm.host.trim(),
        username: rdpForm.username.trim(),
        backend: rdpForm.backend,
      }),
    );
    openRdp({
      host: hostPart,
      port: portPart ? Number(portPart) : null,
      username: rdpForm.username.trim(),
      password: rdpForm.password,
      domain: null,
      width,
      height,
      backend: rdpForm.backend,
    });
    setRdpForm(null);
  }, [rdpForm, openRdp]);

  const toggleFullscreen = useCallback(async (on: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(on);
      setFullscreen(on);
    } catch (e) {
      alert(`全画面表示を切り替えられませんでした: ${e}`);
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

  // 500ms ごとに、出力のあったセッションのサムネールだけ再描画する
  useEffect(() => {
    const iv = setInterval(() => {
      for (const id of dirtyRef.current) {
        const handle = handlesRef.current.get(id);
        const canvas = thumbsRef.current.get(id);
        if (handle && canvas) {
          drawThumb(handle, canvas, THUMB_W, THUMB_H);
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
      const handle = handlesRef.current.get(id);
      if (handle?.kind === "pty") handle.fit.fit();
      // モニター間の移動などで表示倍率が変わったら等倍表示を合わせ直す
      for (const h of handlesRef.current.values()) {
        if (h.kind === "rdp") applyPixelSize(h.canvas);
      }
      // ウィンドウマネージャー側で全画面が解除された場合にも表示を合わせる
      getCurrentWindow()
        .isFullscreen()
        .then(setFullscreen)
        .catch(() => {});
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className={`app ${fullscreen ? "fullscreen" : ""}`}>
      <aside className="sidebar">
        <div className="brand">🐬 Iruka</div>
        <div className="connect-form">
          <button className="new-console-btn" onClick={() => openConsole()}>
            ＋ コンソール
          </button>
          <button
            className="new-console-btn"
            onClick={() => setRdpForm((f) => (f ? null : loadRdpForm()))}
          >
            ＋ RDP
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
        {rdpForm && (
          <form
            className="rdp-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitRdpForm();
            }}
          >
            <input
              placeholder="ホスト（host または host:port）"
              value={rdpForm.host}
              autoFocus
              onChange={(e) => setRdpForm({ ...rdpForm, host: e.target.value })}
            />
            <input
              placeholder={"ユーザー名（DOMAIN\\user 可）"}
              value={rdpForm.username}
              onChange={(e) =>
                setRdpForm({ ...rdpForm, username: e.target.value })
              }
            />
            <input
              type="password"
              placeholder="パスワード"
              value={rdpForm.password}
              onChange={(e) =>
                setRdpForm({ ...rdpForm, password: e.target.value })
              }
            />
            <div className="rdp-form-row">
              <select
                title="RDP の接続方式"
                value={rdpForm.backend}
                onChange={(e) =>
                  setRdpForm({
                    ...rdpForm,
                    backend: e.target.value as RdpBackendKind,
                  })
                }
              >
                {RDP_BACKENDS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
              <button type="submit">接続</button>
              <button type="button" onClick={() => setRdpForm(null)}>
                取消
              </button>
            </div>
          </form>
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
              「＋ コンソール」「＋ RDP」で開きます。
            </div>
          )}
        </div>
      </aside>
      <div className="main-area">
        <main className="main" ref={mainRef}>
          {sessions.length === 0 && (
            <div className="placeholder">
              <div className="placeholder-logo">🐬</div>
              <p>Iruka — console &amp; desktop fleet viewer</p>
            </div>
          )}
        </main>
        {activeSession?.kind === "rdp" && (
          // Remmina 風のツールバー：上端中央のつまみにマウスを乗せると降りてくる
          <div className={`rdp-toolbar ${toolbarPinned ? "pinned" : ""}`}>
            <div className="rdp-toolbar-body">
              <span className="rdp-toolbar-title">{activeSession.title}</span>
              <button
                className={toolbarPinned ? "on" : ""}
                title={toolbarPinned ? "ツールバーの固定を解除" : "ツールバーを固定"}
                onClick={() => setToolbarPinned((v) => !v)}
              >
                📌
              </button>
              <button
                title={fullscreen ? "全画面表示を解除" : "全画面表示"}
                onClick={() => toggleFullscreen(!fullscreen)}
              >
                {fullscreen ? "🗗" : "⛶"}
              </button>
              <button
                className="danger"
                title="切断して閉じる"
                onClick={() => closeSession(activeSession.id)}
              >
                ×
              </button>
            </div>
            <div className="rdp-toolbar-handle" />
          </div>
        )}
      </div>
      {zoom !== null && (
        <div className="zoom-overlay" style={{ top: zoom.top }}>
          <canvas ref={zoomCanvasRef} className="zoom-canvas" />
        </div>
      )}
    </div>
  );
}

export default App;
