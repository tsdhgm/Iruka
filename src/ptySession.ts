import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { hostKeyTracker, VIEW_TOGGLE_KEY } from "./hostKey";
import type { SessionCallbacks, SessionHandle } from "./session";

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null };

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

/**
 * Opens an xterm.js console in `main`, spawns the PTY on the Rust side and wires
 * the two together. Returns null (after alerting the user) when the PTY could not
 * be spawned; the DOM is cleaned up in that case.
 */
export async function createPtySession(
  main: HTMLDivElement,
  cb: SessionCallbacks,
): Promise<{ id: number; handle: SessionHandle } | null> {
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
  // View-toggle key: intercept it before it reaches xterm (Alt+key combinations are
  // detected through altKey, so the key itself never needs to be forwarded).
  const hostKey = hostKeyTracker(VIEW_TOGGLE_KEY, {
    toggle: () => cb.toggleView(),
    sendDown: () => {},
    sendUp: () => {},
  });
  term.attachCustomKeyEventHandler((e) => {
    const handled =
      e.type === "keydown" ? hostKey.keydown(e) : e.type === "keyup" ? hostKey.keyup(e) : false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    return true;
  });
  container.addEventListener("focusout", () => hostKey.reset());
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
    alert(`Failed to start the console: ${e}`);
    return null;
  }

  onEvent.onmessage = (msg) => {
    cb.markDirty(id);
    if (msg.type === "output") {
      cb.markActivity(id);
      term.write(b64ToBytes(msg.data));
    } else {
      cb.updateSession(id, { status: "exited", exitCode: msg.code });
      term.write(
        `\r\n\x1b[90m[Session ended (exit ${msg.code ?? "?"})]\x1b[0m\r\n`,
      );
    }
  };

  term.onData((data) => {
    invoke("write_session", { id, data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    invoke("resize_session", { id, cols, rows }).catch(() => {});
  });

  return { id, handle: { kind: "pty", term, fit, container } };
}
