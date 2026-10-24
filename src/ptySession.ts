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

/** How long after the console starts a password prompt is still answered automatically. */
const AUTO_PASSWORD_WINDOW_MS = 60_000;

/**
 * Watches the console output for a password prompt and types `password` once, the way the
 * user would. Meant for the `ssh` command typed into a fresh console: the first prompt that
 * ends in "password:" within the first minute is ssh's own ("user@host's password:",
 * "Password:" for keyboard-interactive). Nothing is typed a second time, so a wrong
 * password is left for the user to deal with, and key passphrases and host-key questions
 * are never answered.
 */
function passwordPromptAnswerer(password: string, type: (text: string) => void) {
  const decoder = new TextDecoder();
  const started = Date.now();
  let tail = "";
  let done = false;
  return (bytes: Uint8Array) => {
    if (done) return;
    if (Date.now() - started > AUTO_PASSWORD_WINDOW_MS) {
      done = true;
      return;
    }
    // Keep the last few hundred characters, without escape sequences, so a prompt split
    // across two chunks is still seen.
    // eslint-disable-next-line no-control-regex
    tail = (tail + decoder.decode(bytes, { stream: true })).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(-300);
    if (/password:\s*$/i.test(tail)) {
      done = true;
      type(`${password}\r`);
    }
  };
}

/**
 * Opens an xterm.js console in `main`, spawns the PTY on the Rust side and wires
 * the two together. Returns null (after alerting the user) when the PTY could not
 * be spawned; the DOM is cleaned up in that case. With `autoPassword`, the first
 * password prompt is answered with it (see passwordPromptAnswerer).
 */
export async function createPtySession(
  main: HTMLDivElement,
  cb: SessionCallbacks,
  autoPassword?: string,
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

  const answerPrompt = autoPassword
    ? passwordPromptAnswerer(autoPassword, (text) => {
        invoke("write_session", { id, data: text }).catch(() => {});
      })
    : null;
  onEvent.onmessage = (msg) => {
    cb.markDirty(id);
    if (msg.type === "output") {
      cb.markActivity(id);
      const bytes = b64ToBytes(msg.data);
      term.write(bytes);
      answerPrompt?.(bytes);
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
