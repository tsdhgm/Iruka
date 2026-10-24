// Saved connections ("profiles"), like Remmina's connection list. They live in
// localStorage and never hold a password: with "Save password" on, the password is in
// the OS credential store under the profile id (credentials.ts); otherwise it is typed
// at every connection.

import { resolutionSize, type RdpBackendKind, type RdpConnectParams, type RdpResolution } from "./rdp";

export interface SshProfile {
  id: string;
  kind: "ssh";
  name: string;
  host: string;
  username?: string;
  port?: number;
  /** The password is kept in the OS credential store (credentials.ts) under this profile's id. */
  savePassword?: boolean;
}

export interface RdpProfile {
  id: string;
  kind: "rdp";
  name: string;
  /** As typed in the connect form: "host" or "host:port". */
  host: string;
  username: string;
  backend: RdpBackendKind;
  audio: boolean;
  microphone: boolean;
  smallCache: boolean;
  clipboard: boolean;
  resolution: RdpResolution;
  /** The password is kept in the OS credential store (credentials.ts) under this profile's id. */
  savePassword?: boolean;
}

export type Profile = SshProfile | RdpProfile;

/** What an SSH connection needs; a saved profile is one, a one-off form entry is another. */
export interface SshTarget {
  name?: string;
  host: string;
  username?: string;
  port?: number;
}

const STORAGE_KEY = "iruka.profiles";

function isProfile(p: unknown): p is Profile {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.kind === "ssh" || o.kind === "rdp") &&
    typeof o.name === "string" &&
    typeof o.host === "string"
  );
}

export function loadProfiles(): Profile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isProfile) : [];
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: Profile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // Storage may be full or unavailable; the list is still kept in memory for this run.
  }
}

/** Two profiles describe the same place when kind, host, user and port match. */
function sameTarget(a: Profile, b: Profile): boolean {
  if (a.kind !== b.kind || a.host !== b.host || (a.username ?? "") !== (b.username ?? "")) return false;
  return a.kind === "rdp" || b.kind === "rdp" || (a.port ?? 22) === (b.port ?? 22);
}

/**
 * Replace the profile with the same id, or else one that points at the same target
 * (connecting twice to a host must not create two entries), or append it. Returns the
 * new list and the entry as stored (its id may be the existing entry's, not `profile.id`).
 */
export function upsertProfile(profile: Profile): { profiles: Profile[]; stored: Profile } {
  const profiles = loadProfiles();
  let index = profiles.findIndex((p) => p.id === profile.id);
  if (index < 0) index = profiles.findIndex((p) => sameTarget(p, profile));
  let stored: Profile;
  if (index >= 0) {
    stored = { ...profile, id: profiles[index].id };
    profiles[index] = stored;
  } else {
    stored = profile;
    profiles.push(profile);
  }
  saveProfiles(profiles);
  return { profiles, stored };
}

/** The connection parameters of a saved RDP connection (the password comes from the caller). */
export function rdpParamsFromProfile(profile: RdpProfile, password: string): RdpConnectParams {
  const [hostPart, portPart] = profile.host.trim().split(":");
  const { width, height } = resolutionSize(profile.resolution);
  return {
    host: hostPart,
    port: portPart ? Number(portPart) : null,
    username: profile.username,
    password,
    domain: null,
    width,
    height,
    backend: profile.backend,
    audio: profile.audio,
    microphone: profile.microphone,
    smallCache: profile.smallCache,
    clipboard: profile.clipboard,
  };
}

/** Remove the profile with this id (no-op when absent). Returns the new list. */
export function removeProfile(id: string): Profile[] {
  const profiles = loadProfiles().filter((p) => p.id !== id);
  saveProfiles(profiles);
  return profiles;
}

export function newProfileId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the time-based id.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Hosts and user names are typed into a shell unquoted, so only plain tokens are
// accepted: letters, digits, "." "-" "_" and ":" / "%" for IPv6 literals.
const PLAIN_TOKEN = /^[A-Za-z0-9._:%-]+$/;

export function isPlainToken(value: string): boolean {
  return PLAIN_TOKEN.test(value);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The command typed into the console for an SSH target: `ssh [-p PORT] [USER@]HOST`.
 * Returns null when a value is not a plain token (whitespace, shell metacharacters).
 */
export function buildSshCommand(target: SshTarget): string | null {
  let host = target.host.trim();
  let username = target.username?.trim() ?? "";
  if (!username && host.includes("@")) {
    const at = host.indexOf("@");
    username = host.slice(0, at);
    host = host.slice(at + 1);
  }
  if (!host || !isPlainToken(host)) return null;
  if (username && !isPlainToken(username)) return null;
  if (target.port !== undefined && !isValidPort(target.port)) return null;
  const parts = ["ssh"];
  if (target.port !== undefined) parts.push("-p", String(target.port));
  parts.push(username ? `${username}@${host}` : host);
  return parts.join(" ");
}
