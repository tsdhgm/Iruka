import { useState } from "react";
import {
  RDP_BACKENDS,
  RDP_RESOLUTIONS,
  type RdpBackendKind,
  type RdpConnectParams,
  type RdpResolution,
} from "../rdp";
import { newProfileId, type RdpProfile } from "../profiles";

interface RdpFormValues {
  name: string;
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
      name: "",
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
      name: "",
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

/** Form values taken from a saved connection (the password is always typed). */
function fromProfile(profile: RdpProfile): RdpFormValues {
  return {
    name: profile.name,
    host: profile.host,
    username: profile.username,
    password: "",
    backend: profile.backend,
    audio: profile.audio,
    microphone: profile.microphone,
    smallCache: profile.smallCache,
    clipboard: profile.clipboard,
    resolution: profile.resolution,
  };
}

/**
 * The RDP connect form in the sidebar. The last-used values (except the password)
 * are kept in localStorage and loaded when the form is mounted. With `initial`
 * it is pre-filled from a saved connection instead and keeps that profile's id.
 */
export function RdpForm({
  initial,
  onConnect,
  onSave,
  onCancel,
}: {
  initial?: RdpProfile;
  /** Connect with `params`; `profile` is the saved entry to upsert (null when no name was given). */
  onConnect: (params: RdpConnectParams, profile: RdpProfile | null) => void;
  onSave: (profile: RdpProfile) => void;
  onCancel: () => void;
}) {
  const [rdpForm, setRdpForm] = useState<RdpFormValues>(() =>
    initial ? fromProfile(initial) : loadRdpForm(),
  );

  /** The saved-connection entry for the current fields; `name` falls back to the host. */
  const toProfile = (): RdpProfile => ({
    id: initial?.id ?? newProfileId(),
    kind: "rdp",
    name: rdpForm.name.trim() || rdpForm.host.trim(),
    host: rdpForm.host.trim(),
    username: rdpForm.username.trim(),
    backend: rdpForm.backend,
    audio: rdpForm.audio,
    microphone: rdpForm.microphone,
    smallCache: rdpForm.smallCache,
    clipboard: rdpForm.clipboard,
    resolution: rdpForm.resolution,
  });

  const saveProfile = () => {
    if (!rdpForm.host.trim()) return;
    onSave(toProfile());
  };

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
    // Every connection is remembered (named after the host when no name is given).
    onConnect(params, toProfile());
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
        placeholder="Name (optional, saves this connection)"
        value={rdpForm.name}
        onChange={(e) => setRdpForm({ ...rdpForm, name: e.target.value })}
      />
      <input
        placeholder="Host (host or host:port)"
        value={rdpForm.host}
        autoFocus={!initial}
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
        autoFocus={!!initial}
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
        <button type="button" onClick={saveProfile}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
