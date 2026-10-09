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
  RDP_RESOLUTIONS,
  type MemoryCheck,
  type RdpBackendKind,
  type RdpConnectParams,
  type RdpResolution,
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
  audio: boolean;
  microphone: boolean;
  smallCache: boolean;
  clipboard: boolean;
  resolution: RdpResolution;
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

function resolutionSize(r: RdpResolution): { width: number; height: number } {
  if (r === "local") return localDesktopSize();
  const [width, height] = r.split("x").map(Number);
  return { width, height };
}

function resolutionLabel(r: RdpResolution): string {
  if (r === "local") {
    const { width, height } = localDesktopSize();
    return `ローカルと同じ（${width}×${height}）`;
  }
  return r.replace("x", "×");
}

const formatMb = (bytes: number) => `${Math.round(bytes / 1048576).toLocaleString()} MB`;

function loadRdpForm(): RdpForm {
  try {
    const saved = JSON.parse(localStorage.getItem("iruka.rdpForm") ?? "{}");
    return {
      host: saved.host ?? "",
      username: saved.username ?? "",
      password: "",
      backend: saved.backend ?? "auto",
      audio: saved.audio ?? false,
      microphone: saved.microphone ?? false,
      smallCache: saved.smallCache ?? true,
      clipboard: saved.clipboard ?? true,
      resolution: saved.resolution ?? "local",
    };
  } catch {
    return {
      host: "",
      username: "",
      password: "",
      backend: "auto",
      audio: false,
      microphone: false,
      smallCache: true,
      clipboard: true,
      resolution: "local",
    };
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

/** 一覧表示の列数の上限と、タイルの余白・隙間（px） */
const GRID_MAX_COLS = 6;
const GRID_PAD = 8;
const GRID_GAP = 8;
/** 直近この時間（ms）内に出力があれば「実行中」とみなす（Claude Code などのスピナーは常に出力している） */
const RUNNING_WINDOW_MS = 2000;

/** 待機時間の表示（例: 45秒 / 3分 / 2時間） */
function formatIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  return `${Math.floor(s / 3600)}時間`;
}

/**
 * コンソールが実行中か待機中かの表示。
 * ssh の先のコマンドの状態は直接わからないので、出力が続いているかで判定する。
 * 出力を出さずに動くコマンドは「待機」に見えるが、AI エージェントの監視には十分。
 */
function ActivityBadge({
  session,
  lastActivity,
}: {
  session: SessionInfo;
  lastActivity: number | undefined;
}) {
  if (session.kind !== "pty") return null;
  if (session.status === "exited") return <span className="badge exited">終了</span>;
  const idle = Date.now() - (lastActivity ?? 0);
  if (idle < RUNNING_WINDOW_MS) return <span className="badge running">実行中</span>;
  return (
    <span className="badge idle" title="最後の出力からの経過時間">
      待機 {formatIdle(idle)}
    </span>
  );
}

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
  // 接続前の確認（自分自身への接続、空きメモリ不足）。接続を待たせている設定を持つ
  const [connectWarning, setConnectWarning] = useState<
    | { kind: "self"; params: RdpConnectParams }
    | { kind: "memory"; params: RdpConnectParams; check: MemoryCheck }
    | null
  >(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarPinned, setToolbarPinned] = useState(false);
  // 右ペインの表示：1 セッションを大きく（single）か、全セッションをタイルで（grid）か
  const [view, setView] = useState<"single" | "grid">("single");
  const viewRef = useRef<"single" | "grid">("single");
  viewRef.current = view;
  const [gridCols, setGridCols] = useState<number>(() => {
    const n = Number(localStorage.getItem("iruka.gridCols"));
    return n >= 1 && n <= GRID_MAX_COLS ? n : 3;
  });
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [mainWidth, setMainWidth] = useState(0);
  const gridCanvasRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // 最後に出力（コンソール）や画面更新（RDP）があった時刻。実行中か待機中かの判定に使う
  const lastActivityRef = useRef<Map<number, number>>(new Map());
  // 待機時間の表示を定期的に更新するためのカウンタ
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
      // 一覧表示中は RDP を表示していないので、リモートでのコピーをローカルに入れない
      invoke("rdp_set_active", { id: null }).catch(() => {});
      return;
    }
    const handle = handlesRef.current.get(id);
    if (handle) {
      requestAnimationFrame(() => {
        if (handle.kind === "pty") {
          handle.fit.fit();
          handle.term.focus();
          // RDP 以外を表示中は、リモートでのコピーをローカルに入れない
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
          lastActivityRef.current.set(id, Date.now());
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
        if (sid !== null) {
          dirtyRef.current.add(sid);
          lastActivityRef.current.set(sid, Date.now());
        }
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
      // 前面に来たら、このセッションとクリップボードを同期する（ローカルの内容を渡す）
      canvas.addEventListener("focus", () => {
        invoke("rdp_set_active", { id }).catch(() => {});
      });

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

  /**
   * 接続前の確認をしてから接続する。確認で止めたときは、ダイアログの「続ける」から
   * その確認を飛ばして（skip）もう一度呼ぶ。どの確認も、できなくても接続はできるようにする。
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
          // 判定できなければ確認なしで進む
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
          // 確認できなくても接続はできるようにする
        }
      }
      openRdp(params);
    },
    [openRdp],
  );

  const submitRdpForm = useCallback(async () => {
    if (!rdpForm || !rdpForm.host.trim() || !rdpForm.username.trim()) return;
    const [hostPart, portPart] = rdpForm.host.trim().split(":");
    const { width, height } = resolutionSize(rdpForm.resolution);
    localStorage.setItem(
      "iruka.rdpForm",
      JSON.stringify({
        host: rdpForm.host.trim(),
        username: rdpForm.username.trim(),
        backend: rdpForm.backend,
        audio: rdpForm.audio,
        microphone: rdpForm.microphone,
        smallCache: rdpForm.smallCache,
        clipboard: rdpForm.clipboard,
        resolution: rdpForm.resolution,
      }),
    );
    const params: RdpConnectParams = {
      host: hostPart,
      port: portPart ? Number(portPart) : null,
      username: rdpForm.username.trim(),
      password: rdpForm.password,
      domain: null,
      width,
      height,
      backend: rdpForm.backend,
      audio: rdpForm.audio,
      microphone: rdpForm.microphone,
      smallCache: rdpForm.smallCache,
      clipboard: rdpForm.clipboard,
    };
    setRdpForm(null);
    connectWithChecks(params, {});
  }, [rdpForm, connectWithChecks]);

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

  // 500ms ごとに、出力のあったセッションのサムネール（サイドバーと一覧のタイル）だけ再描画する
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

  // 一覧の表示を切り替えたとき：セッションの表示を合わせ、タイルを全部描く
  useEffect(() => {
    const id = activeIdRef.current;
    if (id !== null) showSession(id);
    if (view === "grid") {
      for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
    }
  }, [view, showSession]);

  // 右ペインの幅（タイルの大きさの計算に使う）
  useEffect(() => {
    const el = mainAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setMainWidth(entry.contentRect.width);
      // 幅が変わるとタイルの大きさも変わるので描き直す
      for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    // 他のアプリでコピーして戻ってきたときも、表示中の RDP セッションに渡す
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
  // タイルは 16:9。右ペインの幅から列数で割る（余白と隙間を除く）
  const tileW = Math.max(
    80,
    Math.floor((mainWidth - GRID_PAD * 2 - GRID_GAP * (gridCols - 1)) / gridCols),
  );
  const tileH = Math.round((tileW * 9) / 16);

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
            <select
              title="リモートの解像度（大きいほどメモリを使う）"
              value={rdpForm.resolution}
              onChange={(e) =>
                setRdpForm({
                  ...rdpForm,
                  resolution: e.target.value as RdpResolution,
                })
              }
            >
              {RDP_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {resolutionLabel(r)}
                </option>
              ))}
            </select>
            <div className="rdp-form-checks" title="FreeRDP で接続したときのみ有効">
              <label>
                <input
                  type="checkbox"
                  checked={rdpForm.audio}
                  onChange={(e) =>
                    setRdpForm({ ...rdpForm, audio: e.target.checked })
                  }
                />
                音声
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={rdpForm.microphone}
                  onChange={(e) =>
                    setRdpForm({ ...rdpForm, microphone: e.target.checked })
                  }
                />
                マイク
              </label>
              <label title="RDPGFX のキャッシュを 100MB から 16MB に減らす">
                <input
                  type="checkbox"
                  checked={rdpForm.smallCache}
                  onChange={(e) =>
                    setRdpForm({ ...rdpForm, smallCache: e.target.checked })
                  }
                />
                省メモリ
              </label>
              <label title="テキストのコピー＆ペーストを共有（表示中のセッションのみ）">
                <input
                  type="checkbox"
                  checked={rdpForm.clipboard}
                  onChange={(e) =>
                    setRdpForm({ ...rdpForm, clipboard: e.target.checked })
                  }
                />
                クリップボード
              </label>
            </div>
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
                <ActivityBadge session={s} lastActivity={lastActivityRef.current.get(s.id)} />
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
          // 一覧：全セッションを 16:9 のタイルで並べる。縦にはみ出す分はスクロール
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
                title="クリックで単独表示"
                onClick={() => {
                  setView("single");
                  focusSession(s.id);
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
        )}
        {sessions.length > 0 && (
          // Remmina 風のツールバー：上端中央のつまみにマウスを乗せると降りてくる
          <div className={`view-toolbar ${toolbarPinned ? "pinned" : ""}`}>
            <div className="view-toolbar-body">
              <span className="view-toolbar-title">
                {view === "grid" ? `一覧（${sessions.length}）` : activeSession?.title}
              </span>
              <button
                className={view === "grid" ? "on" : ""}
                title={view === "grid" ? "単独表示に戻す" : "全セッションを一覧表示"}
                onClick={() => setView((v) => (v === "grid" ? "single" : "grid"))}
              >
                {view === "grid" ? "▣" : "⊞"}
              </button>
              {view === "grid" && (
                <label className="view-toolbar-slider" title={`列数: ${gridCols}`}>
                  <span>🔍</span>
                  <input
                    type="range"
                    min={1}
                    max={GRID_MAX_COLS}
                    value={gridCols}
                    onChange={(e) => changeGridCols(Number(e.target.value))}
                  />
                  <span className="view-toolbar-cols">{gridCols} 列</span>
                </label>
              )}
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
              {view === "single" && activeSession && (
                <button
                  className="danger"
                  title={activeSession.kind === "rdp" ? "切断して閉じる" : "コンソールを閉じる"}
                  onClick={() => closeSession(activeSession.id)}
                >
                  ×
                </button>
              )}
            </div>
            <div className="view-toolbar-handle" />
          </div>
        )}
      </div>
      {connectWarning?.kind === "self" && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>この PC 自身に接続しようとしています</h2>
            <p>
              {connectWarning.params.host} は、Iruka を動かしているこの PC です。
            </p>
            <p className="modal-note">
              自分自身の画面共有につなぐと、リモート画面の中でマウスを動かすたびに本物のカーソルが
              動かされ、左上へ吸い寄せられてカーソルを見失います。
              別の PC に接続するつもりなら「やめる」を押して、接続先を確かめてください。
            </p>
            <div className="modal-buttons">
              <button onClick={() => setConnectWarning(null)}>やめる</button>
              <button
                className="danger"
                onClick={() => {
                  const { params } = connectWarning;
                  setConnectWarning(null);
                  connectWithChecks(params, { self: true });
                }}
              >
                それでも接続する
              </button>
            </div>
          </div>
        </div>
      )}
      {connectWarning?.kind === "memory" && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <h2>メモリが足りない可能性があります</h2>
            <p>
              {connectWarning.params.host}（{connectWarning.params.width}×
              {connectWarning.params.height}）への接続には、約{" "}
              {formatMb(connectWarning.check.estimatedBytes)} 必要と見込んでいます。
              空きメモリは約 {formatMb(connectWarning.check.availableBytes)} です。
            </p>
            <p className="modal-note">
              {connectWarning.check.learned
                ? `見積もりは、これまでの使用量から学習した値（標準の ${connectWarning.check.scale.toFixed(2)} 倍）に基づきます。`
                : "まだ使用量を学習していないため、初期値で見積もっています。"}
              接続すると、動作が遅くなったり不安定になったりすることがあります。
              解像度を下げると必要量が減ります。
            </p>
            <div className="modal-buttons">
              <button onClick={() => setConnectWarning(null)}>やめる</button>
              <button
                className="danger"
                onClick={() => {
                  openRdp(connectWarning.params);
                  setConnectWarning(null);
                }}
              >
                それでも接続する
              </button>
            </div>
          </div>
        </div>
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
