import { useState } from "react";
import {
  buildSshCommand,
  isValidPort,
  newProfileId,
  type SshProfile,
  type SshTarget,
} from "../profiles";

interface SshFormValues {
  name: string;
  host: string;
  username: string;
  port: string;
}

const TOKEN_ERROR = "Host, user and port must be plain tokens (no spaces or shell characters).";

/**
 * The SSH connect form in the sidebar. It only collects the target; the console
 * does the rest (the ssh command is typed into a local shell). With `initial`
 * it edits a saved profile and keeps its id.
 */
export function SshForm({
  initial,
  onConnect,
  onSave,
  onCancel,
}: {
  initial?: SshProfile;
  /** Connect to `target`; `profile` is the saved entry to upsert (null when no name was given). */
  onConnect: (target: SshTarget, profile: SshProfile | null) => void;
  onSave: (profile: SshProfile) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<SshFormValues>({
    name: initial?.name ?? "",
    host: initial?.host ?? "",
    username: initial?.username ?? "",
    port: initial?.port !== undefined ? String(initial.port) : "",
  });
  const [error, setError] = useState<string | null>(null);

  /** Validate the fields; returns the target or null (with the error shown inline). */
  const readTarget = (): SshTarget | null => {
    let host = form.host.trim();
    let username = form.username.trim();
    if (!username && host.includes("@")) {
      const at = host.indexOf("@");
      username = host.slice(0, at);
      host = host.slice(at + 1);
    }
    if (!host) {
      setError("Host is required.");
      return null;
    }
    const portText = form.port.trim();
    const port = portText ? Number(portText) : undefined;
    if (port !== undefined && !isValidPort(port)) {
      setError("Port must be a number from 1 to 65535.");
      return null;
    }
    const target: SshTarget = { host, port };
    if (username) target.username = username;
    if (!buildSshCommand(target)) {
      setError(TOKEN_ERROR);
      return null;
    }
    setError(null);
    return target;
  };

  const toProfile = (target: SshTarget, name: string): SshProfile => ({
    id: initial?.id ?? newProfileId(),
    kind: "ssh",
    name,
    host: target.host,
    username: target.username,
    port: target.port,
  });

  const connect = () => {
    const target = readTarget();
    if (!target) return;
    // Every connection is remembered (named after the host when no name is given).
    const name = form.name.trim() || (target.username ? `${target.username}@${target.host}` : target.host);
    onConnect({ ...target, name }, toProfile(target, name));
  };

  const save = () => {
    const target = readTarget();
    if (!target) return;
    onSave(toProfile(target, form.name.trim() || (target.username ? `${target.username}@${target.host}` : target.host)));
  };

  return (
    <form
      className="rdp-form"
      onSubmit={(e) => {
        e.preventDefault();
        connect();
      }}
    >
      <input
        placeholder="Name (optional, saves this connection)"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <input
        placeholder="Host (host or user@host)"
        value={form.host}
        autoFocus
        onChange={(e) => setForm({ ...form, host: e.target.value })}
      />
      <input
        placeholder="User (optional)"
        value={form.username}
        onChange={(e) => setForm({ ...form, username: e.target.value })}
      />
      <input
        type="number"
        min={1}
        max={65535}
        placeholder="Port (optional)"
        value={form.port}
        onChange={(e) => setForm({ ...form, port: e.target.value })}
      />
      {error && <div className="rdp-form-error">{error}</div>}
      <div className="rdp-form-row">
        <button type="submit">Connect</button>
        <button type="button" onClick={save}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
