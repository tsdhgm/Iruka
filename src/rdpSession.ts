import { invoke, Channel } from "@tauri-apps/api/core";
import { hostKeyTracker, VIEW_TOGGLE_KEY } from "./hostKey";
import {
  MAX_CURSOR_SHAPES,
  SCANCODES,
  remoteCursorStyle,
  toRemoteCoords,
  type RdpConnectParams,
  type RdpEvent,
  type RdpInput,
} from "./rdp";
import type { SessionCallbacks, SessionHandle } from "./session";

/**
 * "Scaled" display: the whole remote screen fitted into the viewport (aspect kept, scaled
 * both down and up) instead of 1:1 with scrollbars. One setting for all RDP sessions,
 * remembered in localStorage; the toolbar toggles it and re-applies the size to every canvas.
 */
let scaledDisplay = localStorage.getItem("iruka.scaled") === "1";
export function isScaledDisplay(): boolean {
  return scaledDisplay;
}
export function setScaledDisplay(on: boolean) {
  scaledDisplay = on;
  localStorage.setItem("iruka.scaled", on ? "1" : "0");
}

/**
 * Size the canvas on screen: one remote pixel per physical pixel (cancelling out the OS
 * display scale), or, with the scaled display on, fitted into its scroller. Input mapping
 * (toRemoteCoords) works from the on-screen size, so it follows automatically; only the
 * remote's cursor shapes stay at their own pixel size.
 */
export function applyPixelSize(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const viewport = canvas.parentElement;
  if (scaledDisplay && viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
    const scale = Math.min(viewport.clientWidth / canvas.width, viewport.clientHeight / canvas.height);
    canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
    canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
    return;
  }
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
}

/**
 * Creates the canvas for an RDP desktop in `main`, starts the connection on the
 * Rust side and wires up frames, events and input. Returns null (after alerting
 * the user) when the connection could not be started; the DOM is cleaned up in
 * that case.
 */
export async function createRdpSession(
  main: HTMLDivElement,
  params: RdpConnectParams,
  cb: SessionCallbacks,
): Promise<{ id: number; handle: SessionHandle } | null> {
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
  status.textContent = `Connecting to ${params.host}…`;
  scroller.append(canvas);
  container.append(scroller, status);
  applyPixelSize(canvas);
  main.appendChild(container);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Performance measurement (for investigation): every 2 seconds, write the receive
  // lag and the time spent drawing to the Rust-side log.
  const perf = { frames: 0, kb: 0, handleMs: 0, maxLag: 0, maxHandle: 0 };

  // Screen contents arrive as binary (see the FrameSink comments on the Rust side for the format).
  let sid: number | null = null;
  // Back-pressure: the backend sends the next frame only after this one is acknowledged, and
  // the acknowledgement waits for the next animation frame, so the rate follows what the
  // display shows instead of piling up in the WebView (FrameGate on the Rust side). A frame
  // that arrives before the session id is known is acknowledged as soon as it is.
  let unackedSeq: number | null = null;
  const ackFrame = (seq: number) => {
    if (sid === null) {
      unackedSeq = seq;
      return;
    }
    requestAnimationFrame(() => {
      invoke("rdp_frame_done", { id: sid, seq }).catch(() => {});
    });
  };
  const onFrame = new Channel<ArrayBuffer>();
  onFrame.onmessage = (buf) => {
    const t0 = performance.now();
    const view = new DataView(buf);
    const fbWidth = view.getUint32(0, true);
    const fbHeight = view.getUint32(4, true);
    const count = view.getUint32(8, true);
    const seq = view.getUint32(12, true);
    const sentAt = view.getFloat64(16, true);
    // Drop data that crossed over a resize (a full frame arrives after the canvas is rebuilt).
    if (fbWidth !== canvas.width || fbHeight !== canvas.height) {
      ackFrame(seq);
      return;
    }
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
      cb.markDirty(sid);
      cb.markActivity(sid);
    }
    ackFrame(seq);
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
    if (unackedSeq !== null) {
      ackFrame(unackedSeq);
      unackedSeq = null;
    }
  } catch (e) {
    container.remove();
    alert(`Could not start the RDP connection: ${e}`);
    return null;
  }

  const perfTimer = setInterval(() => {
    if (perf.frames === 0) return;
    invoke("rdp_perf_log", {
      message: `id=${id} frames=${perf.frames} kb=${perf.kb} handle_ms_total=${perf.handleMs.toFixed(1)} handle_ms_max=${perf.maxHandle.toFixed(1)} lag_ms_max=${perf.maxLag.toFixed(0)}`,
    }).catch(() => {});
    Object.assign(perf, { frames: 0, kb: 0, handleMs: 0, maxLag: 0, maxHandle: 0 });
  }, 2000);

  // Cursor shape: the remote sends each shape once (cursorImage) and then selects one by
  // id (cursor); the canvas's CSS cursor follows (see "Pointer" in freerdp_bridge.c).
  const cursors = new Map<number, string>();
  let cursorId: number | null = 0;
  const applyCursor = () => {
    canvas.style.cursor =
      cursorId === null ? "none" : cursorId === 0 ? "default" : (cursors.get(cursorId) ?? "default");
  };

  onEvent.onmessage = (msg) => {
    if (msg.type === "cursorImage") {
      cursors.set(msg.id, remoteCursorStyle(msg));
      if (cursors.size > MAX_CURSOR_SHAPES) {
        cursors.delete(cursors.keys().next().value!);
      }
      if (msg.id === cursorId) applyCursor();
    } else if (msg.type === "cursor") {
      cursorId = msg.id;
      applyCursor();
    } else if (msg.type === "link") {
      // The overlay says what the backend knows; the sidebar follows (reconnecting counts as
      // connecting). Nothing else changes: the screen keeps its last content and input still
      // reaches the backend, which drops it while the link is down.
      const link = msg.link;
      status.classList.remove("error");
      status.classList.toggle("warn", link.state !== "ok");
      if (link.state === "ok") {
        status.style.display = "none";
        cb.updateSession(id, { status: "running", message: null });
      } else {
        status.style.display = "";
        status.textContent =
          link.state === "stalled"
            ? `No answer from ${params.host} for ${link.seconds} s…`
            : `Connection lost. Reconnecting to ${params.host} (${link.attempt} of ${link.attempts})…`;
        cb.updateSession(id, {
          status: link.state === "reconnecting" ? "connecting" : "running",
          message: status.textContent,
        });
      }
    } else if (msg.type === "resize") {
      canvas.width = msg.width;
      canvas.height = msg.height;
      applyPixelSize(canvas);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      status.style.display = "none";
      status.classList.remove("warn");
      cb.updateSession(id, { status: "running", message: null });
      cb.markDirty(id);
    } else {
      clearInterval(perfTimer);
      cursorId = 0;
      applyCursor();
      status.style.display = "";
      status.textContent = msg.error
        ? `Connection error (${msg.backend}): ${msg.reason}`
        : `Disconnected (${msg.backend}): ${msg.reason}`;
      status.classList.remove("warn");
      status.classList.toggle("error", msg.error);
      cb.updateSession(id, { status: "exited", message: msg.reason });
    }
  };

  // Input is batched per animation frame (only the latest mouse move is kept).
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
  // View-toggle key: on its own it switches to the grid; held while another key is
  // pressed, it goes to the remote as an ordinary modifier.
  const hostScancode = SCANCODES[VIEW_TOGGLE_KEY];
  const hostKey = hostKeyTracker(VIEW_TOGGLE_KEY, {
    toggle: () => cb.toggleView(),
    sendDown: () => {
      if (hostScancode !== undefined) send({ type: "key", scancode: hostScancode, down: true });
    },
    sendUp: () => {
      if (hostScancode !== undefined) send({ type: "key", scancode: hostScancode, down: false });
    },
  });
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (down ? hostKey.keydown(e) : hostKey.keyup(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const scancode = SCANCODES[e.code];
    if (scancode === undefined) return;
    e.preventDefault();
    send({ type: "key", scancode, down });
  };
  canvas.addEventListener("keydown", onKey(true));
  canvas.addEventListener("keyup", onKey(false));
  canvas.addEventListener("blur", () => {
    hostKey.reset();
    send({ type: "releaseAll" });
  });
  // When brought to the front, sync the clipboard with this session (hand over the local contents).
  canvas.addEventListener("focus", () => {
    invoke("rdp_set_active", { id }).catch(() => {});
  });

  return { id, handle: { kind: "rdp", canvas, container } };
}
