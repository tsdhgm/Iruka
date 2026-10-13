import { useState } from "react";
import {
  RDP_BACKENDS,
  RDP_RESOLUTIONS,
  type RdpBackendKind,
  type RdpConnectParams,
  type RdpResolution,
} from "../rdp";

interface RdpFormValues {
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
 * Requested remote resolution = the local monitor's physical resolution (same as a
 * full-screen mstsc connection). In full screen it fits exactly at 1:1; in a window
 * the overflow is reached by scrolling. Screen-sharing servers (GNOME Remote Desktop)
 * announce their own screen size, so the actual size follows the server's resize event.
 */
function localDesktopSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  // Keep within the range RDP allows (200-8192) and make the width even.
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
    return `Same as local (${width}×${height})`;
  }
  return r.replace("x", "×");
}

function loadRdpForm(): RdpFormValues {
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

/**
 * The RDP connect form in the sidebar. The last-used values (except the password)
 * are kept in localStorage and loaded when the form is mounted.
 */
export function RdpForm({
  onConnect,
  onCancel,
}: {
  onConnect: (params: RdpConnectParams) => void;
  onCancel: () => void;
}) {
  const [rdpForm, setRdpForm] = useState<RdpFormValues>(loadRdpForm);

  const submitRdpForm = () => {
    if (!rdpForm.host.trim() || !rdpForm.username.trim()) return;
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
    onConnect(params);
  };

  return (
    <form
      className="rdp-form"
      onSubmit={(e) => {
        e.preventDefault();
        submitRdpForm();
      }}
    >
      <input
        placeholder="Host (host or host:port)"
        value={rdpForm.host}
        autoFocus
        onChange={(e) => setRdpForm({ ...rdpForm, host: e.target.value })}
      />
      <input
        placeholder={"User (DOMAIN\\user allowed)"}
        value={rdpForm.username}
        onChange={(e) =>
          setRdpForm({ ...rdpForm, username: e.target.value })
        }
      />
      <input
        type="password"
        placeholder="Password"
        value={rdpForm.password}
        onChange={(e) =>
          setRdpForm({ ...rdpForm, password: e.target.value })
        }
      />
      <select
        title="Resolution (larger uses more memory)"
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
      <div className="rdp-form-checks" title="Only effective with the FreeRDP backend">
        <label>
          <input
            type="checkbox"
            checked={rdpForm.audio}
            onChange={(e) =>
              setRdpForm({ ...rdpForm, audio: e.target.checked })
            }
          />
          Audio
        </label>
        <label>
          <input
            type="checkbox"
            checked={rdpForm.microphone}
            onChange={(e) =>
              setRdpForm({ ...rdpForm, microphone: e.target.checked })
            }
          />
          Microphone
        </label>
        <label title="Reduce the RDPGFX cache from 100MB to 16MB">
          <input
            type="checkbox"
            checked={rdpForm.smallCache}
            onChange={(e) =>
              setRdpForm({ ...rdpForm, smallCache: e.target.checked })
            }
          />
          Low memory
        </label>
        <label title="Share text copy & paste (active session only)">
          <input
            type="checkbox"
            checked={rdpForm.clipboard}
            onChange={(e) =>
              setRdpForm({ ...rdpForm, clipboard: e.target.checked })
            }
          />
          Clipboard
        </label>
      </div>
      <div className="rdp-form-row">
        <select
          title="Backend"
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
        <button type="submit">Connect</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
