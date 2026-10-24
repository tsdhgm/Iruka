import { useState } from "react";
import type { Workset } from "../worksets";

/**
 * The "Worksets" section of the sidebar: save the open sessions under a name, bring a
 * saved set back, or bring back the set that was open most recently. Clicking an entry
 * restores it (the same gesture as connecting to a saved connection).
 */
export function WorksetSection({
  worksets,
  last,
  canSave,
  restoring,
  onSave,
  onRestore,
  onDelete,
}: {
  worksets: Workset[];
  /** The automatically remembered set of sessions open most recently, if any. */
  last: Workset | null;
  /** Whether at least one open session came from a saved connection (plain consoles are not saved). */
  canSave: boolean;
  /** Name of the workset being restored right now, or null. */
  restoring: string | null;
  onSave: (name: string) => void;
  onRestore: (workset: Workset) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem("iruka.worksetsOpen") === "1");
  const [name, setName] = useState("");
  const busy = restoring !== null;

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || !canSave) return;
    onSave(trimmed);
    setName("");
  };

  const card = (w: Workset, label: string, auto: boolean) => (
    <div
      key={auto ? "last" : w.id}
      className={`profile-card ${busy ? "disabled" : ""}`}
      title={
        busy
          ? `Restoring ${restoring}…`
          : `Restore ${w.profileIds.length} session${w.profileIds.length === 1 ? "" : "s"} (saved ${new Date(w.savedAt).toLocaleString()})`
      }
      onClick={() => {
        if (!busy) onRestore(w);
      }}
    >
      <span className="session-kind">{w.profileIds.length}</span>
      <span className="profile-title">{label}</span>
      {!auto && (
        <button
          className="profile-btn delete"
          title="Delete"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(w.id);
          }}
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <div className="profile-section">
      <button
        className="section-label section-toggle"
        title={open ? "Hide worksets" : "Show worksets"}
        onClick={() =>
          setOpen((v) => {
            const next = !v;
            localStorage.setItem("iruka.worksetsOpen", next ? "1" : "0");
            return next;
          })
        }
      >
        <span className="section-caret">{open ? "▾" : "▸"}</span> Worksets ({worksets.length})
      </button>
      {open && (
        <>
          <form
            className="workset-save"
            title={
              canSave
                ? "Save the open sessions (saved connections only) and the layout under this name"
                : "Open a saved connection first; plain consoles are not part of a workset"
            }
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              placeholder="Name"
              value={name}
              disabled={!canSave || busy}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" disabled={!canSave || busy || !name.trim()}>
              Save
            </button>
          </form>
          {restoring !== null && <div className="workset-status">Restoring {restoring}…</div>}
          {last && card(last, "Last open sessions", true)}
          {worksets.map((w) => card(w, w.name, false))}
          {worksets.length === 0 && !last && (
            <div className="workset-hint">Open some saved connections, then save them as a set.</div>
          )}
        </>
      )}
    </div>
  );
}
