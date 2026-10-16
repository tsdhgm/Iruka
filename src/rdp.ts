// Front-end helpers for RDP sessions (the counterpart of rdp.rs on the Rust side).

export type RdpEvent =
  | { type: "resize"; width: number; height: number }
  | { type: "closed"; reason: string; error: boolean; backend: string };

export type RdpInput =
  | { type: "mouseMove"; x: number; y: number }
  | { type: "mouseButton"; button: number; down: boolean }
  | { type: "wheel"; vertical: boolean; units: number }
  | { type: "key"; scancode: number; down: boolean }
  | { type: "releaseAll" };

export type RdpBackendKind = "auto" | "freerdp" | "ironrdp";

export const RDP_BACKENDS: { value: RdpBackendKind; label: string }[] = [
  { value: "auto", label: "Auto (FreeRDP first)" },
  { value: "freerdp", label: "FreeRDP" },
  { value: "ironrdp", label: "IronRDP (experimental)" },
];

export interface RdpConnectParams {
  host: string;
  port: number | null;
  username: string;
  password: string;
  domain: string | null;
  width: number;
  height: number;
  backend: RdpBackendKind;
  audio: boolean;
  microphone: boolean;
  smallCache: boolean;
  clipboard: boolean;
}

/**
 * What the UI asks for when connecting: the Rust-side params plus a display title
 * (the saved connection's name). The title is stripped before `rdp_connect`.
 */
export interface RdpConnectRequest extends RdpConnectParams {
  title?: string;
}

/** Result of the pre-connect memory check (MemoryCheck in memory.rs on the Rust side). */
export interface MemoryCheck {
  availableBytes: number;
  estimatedBytes: number;
  scale: number;
  learned: boolean;
}

/** Resolution choices. "local" is the physical resolution of the local monitor. */
export type RdpResolution = "local" | "2560x1440" | "1920x1080";

export const RDP_RESOLUTIONS: RdpResolution[] = ["local", "2560x1440", "1920x1080"];

// KeyboardEvent.code → PC/AT scancode (Set 1). Extended keys are 0xE0xx.
// Physical key positions are sent, so the layout (JIS/US) follows the remote side's setting.
export const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29, // Hankaku/Zenkaku on JIS keyboards
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  KanaMode: 0x70, // Katakana/Hiragana
  IntlRo: 0x73, // Backslash / Ro (JIS)
  Convert: 0x79, // Henkan (convert)
  NonConvert: 0x7b, // Muhenkan (non-convert)
  IntlYen: 0x7d, // Yen (JIS)
  NumpadEnter: 0xe01c,
  ControlRight: 0xe01d,
  NumpadDivide: 0xe035,
  PrintScreen: 0xe037,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
};

/** Convert client coordinates on the displayed canvas to pixel coordinates on the remote screen. */
export function toRemoteCoords(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) * canvas.width) / rect.width;
  const y = ((clientY - rect.top) * canvas.height) / rect.height;
  return {
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(x))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.round(y))),
  };
}

/** Draw the contents of a canvas onto a thumbnail canvas, keeping the aspect ratio. */
export function drawCanvasToCanvas(
  src: HTMLCanvasElement,
  dst: HTMLCanvasElement,
  cssW: number,
  cssH: number,
) {
  const dpr = window.devicePixelRatio || 1;
  if (dst.width !== cssW * dpr || dst.height !== cssH * dpr) {
    dst.width = cssW * dpr;
    dst.height = cssH * dpr;
  }
  const ctx = dst.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#11151c";
  ctx.fillRect(0, 0, cssW, cssH);
  if (src.width === 0 || src.height === 0) return;
  const scale = Math.min(cssW / src.width, cssH / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, (cssW - w) / 2, (cssH - h) / 2, w, h);
}
