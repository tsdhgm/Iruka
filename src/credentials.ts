// Passwords of saved connections live in the OS credential store (credentials.rs on the
// Rust side), keyed by the profile id. Nothing here is ever written to localStorage.

import { invoke } from "@tauri-apps/api/core";

/** The stored password of a saved connection, or null when there is none or the store is unavailable. */
export async function loadPassword(profileId: string): Promise<string | null> {
  try {
    return await invoke<string | null>("credential_get", { profileId });
  } catch (e) {
    console.warn(`Could not read the saved password: ${e}`);
    return null;
  }
}

/** Store the password; returns an error message when it could not be stored, else null. */
export async function storePassword(profileId: string, password: string): Promise<string | null> {
  try {
    await invoke("credential_set", { profileId, password });
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Forget the stored password (best effort; nothing to report when there was none). */
export function forgetPassword(profileId: string): void {
  invoke("credential_delete", { profileId }).catch((e) => {
    console.warn(`Could not delete the saved password: ${e}`);
  });
}
