// Worksets: the set of open sessions (as saved-connection ids, in sidebar order) plus the
// layout, so that the same sessions can be brought back after a restart. They live in
// localStorage next to the profiles; passwords are in the OS credential store (credentials.ts).

export interface Workset {
  id: string;
  name: string;
  /** ISO 8601 */
  savedAt: string;
  view: "single" | "grid";
  gridCols: number;
  /** Ids of saved connections (profiles.ts), in the order they were open. */
  profileIds: string[];
}

const STORAGE_KEY = "iruka.worksets";
/** The set of sessions that was open most recently (written automatically). */
const LAST_KEY = "iruka.lastWorkset";

function isWorkset(w: unknown): w is Workset {
  if (typeof w !== "object" || w === null) return false;
  const o = w as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    Array.isArray(o.profileIds) &&
    o.profileIds.every((p) => typeof p === "string")
  );
}

function normalize(w: Workset): Workset {
  return {
    ...w,
    view: w.view === "grid" ? "grid" : "single",
    gridCols: Number.isInteger(w.gridCols) && w.gridCols >= 1 ? w.gridCols : 3,
  };
}

export function loadWorksets(): Workset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isWorkset).map(normalize) : [];
  } catch {
    return [];
  }
}

function saveWorksets(worksets: Workset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(worksets));
  } catch {
    // Storage may be full or unavailable; the list is still kept in memory for this run.
  }
}

/** Replace the workset with the same id or the same name (saving under a used name overwrites), else append. */
export function upsertWorkset(workset: Workset): Workset[] {
  const worksets = loadWorksets();
  let index = worksets.findIndex((w) => w.id === workset.id);
  if (index < 0) index = worksets.findIndex((w) => w.name === workset.name);
  if (index >= 0) worksets[index] = { ...workset, id: worksets[index].id };
  else worksets.push(workset);
  saveWorksets(worksets);
  return worksets;
}

export function removeWorkset(id: string): Workset[] {
  const worksets = loadWorksets().filter((w) => w.id !== id);
  saveWorksets(worksets);
  return worksets;
}

export function loadLastWorkset(): Workset | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    return isWorkset(parsed) ? normalize(parsed) : null;
  } catch {
    return null;
  }
}

export function saveLastWorkset(workset: Workset): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(workset));
  } catch {
    // Best effort.
  }
}

export function newWorksetId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the time-based id.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
