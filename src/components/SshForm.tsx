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
  password: string;
  savePassword: boolean;
}

const TOKEN_ERROR = "Host, user and port must be plain tokens (no spaces or shell characters).";

/**
 * The SSH connect form in the sidebar. It collects the target and, optionally, the
 * password; the console does the rest (the ssh command is typed into a local shell and
 * the password, when given, is typed at ssh's prompt). With `initial` it edits a saved
 * profile and keeps its id.
 */
export function SshForm({
  initial,
  onConnect,
  onSave,
  onCancel,
}: {
  initial?: SshProfile;
  /**
   * Connect to `target`; `profile` is the saved entry to upsert (null when no name was given).
   * `password` is what was typed (empty when the field was left empty).
   */
  onConnect: (target: SshTarget, profile: SshProfile | null, password: string) => void;
  onSave: (profile: SshProfile, password: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<SshFormValues>({
    name: initial?.name ?? "",
    host: initial?.host ?? "",
    username: initial?.username ?? "",
    port: initial?.port !== undefined ? String(initial.port) : "",
    password: "",
    savePassword: initial?.savePassword ?? false,
  });
  const [error, setError] = useState<string | null>(null);
  const hasStoredPassword = !!initial?.savePassword;

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
    savePassword: form.savePassword,
  });

  const connect = () => {
    const target = readTarget();
    if (!target) return;
    // Every connection is remembered (named after the host when no name is given).
    const name = form.name.trim() || (target.username ? `${target.username}@${target.host}` : target.host);
    onConnect({ ...target, name }, toProfile(target, name), form.password);
  };

  const save = () => {
    const target = readTarget();
    if (!target) return;
    onSave(
      toProfile(target, form.name.trim() || (target.username ? `${target.username}@${target.host}` : target.host)),
      form.password,
    );
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
      <input
        type="password"
        placeholder={hasStoredPassword ? "Password (saved; leave empty to use it)" : "Password (optional, typed at ssh's prompt)"}
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
      />
      <div className="rdp-form-checks">
        <label title="Keep the password in the OS credential store (GNOME Keyring / KWallet, Windows Credential Manager, macOS Keychain) and type it at ssh's password prompt, so this connection can be restored without typing it. Anyone using this desktop session can connect as you. SSH keys are the better way when you can set them up.">
          <input
            type="checkbox"
            checked={form.savePassword}
            onChange={(e) => setForm({ ...form, savePassword: e.target.checked })}
          />
          Save password
        </label>
      </div>
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
