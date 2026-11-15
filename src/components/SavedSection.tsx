import { useState } from "react";
import type { Profile } from "../profiles";

/** A folded / unfolded flag remembered in localStorage ("1" / "0"). */
function useStoredFlag(key: string, initial: boolean): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => {
    const v = localStorage.getItem(key);
    return v === null ? initial : v === "1";
  });
  const toggle = () =>
    setOn((v) => {
      localStorage.setItem(key, v ? "0" : "1");
      return !v;
    });
  return [on, toggle];
}

const GROUPS = [
  { kind: "ssh", label: "SSH", key: "iruka.savedOpen.ssh" },
  { kind: "rdp", label: "RDP", key: "iruka.savedOpen.rdp" },
] as const;

/**
 * Saved connections in the sidebar: one foldable group per kind (SSH, RDP), each sorted
 * by name. The order is for display only and does not depend on when a connection was
 * saved, so the list looks the same on every machine with the same connections. Numbers
 * inside names compare as numbers ("10.0.1.51" before "10.0.1.113").
 */
export function SavedSection({
  profiles,
  onOpen,
  onEdit,
  onDelete,
}: {
  profiles: Profile[];
  onOpen: (p: Profile) => void;
  onEdit: (p: Profile) => void;
  onDelete: (id: string) => void;
}) {
  const [open, toggleOpen] = useStoredFlag("iruka.savedOpen", false);
  const [descending, toggleDescending] = useStoredFlag("iruka.savedDescending", false);
  const groupOpen = {
    ssh: useStoredFlag(GROUPS[0].key, true),
    rdp: useStoredFlag(GROUPS[1].key, true),
  };
  if (profiles.length === 0) return null;

  const sorted = [...profiles].sort(
    (a, b) =>
      (descending ? -1 : 1) *
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );

  return (
    <div className="profile-section">
      <div className="section-row">
        <button
          className="section-label section-toggle"
          title={open ? "Hide saved connections" : "Show saved connections"}
          onClick={toggleOpen}
        >
          <span className="section-caret">{open ? "▾" : "▸"}</span> Saved ({profiles.length})
        </button>
        {open && (
          <button
            className="section-sort"
            title={descending ? "Sorted by name, Z to A (click for A to Z)" : "Sorted by name, A to Z (click for Z to A)"}
            onClick={toggleDescending}
          >
            {descending ? "Z→A" : "A→Z"}
          </button>
        )}
      </div>
      {open &&
        GROUPS.map((g) => {
          const items = sorted.filter((p) => p.kind === g.kind);
          if (items.length === 0) return null;
          const [isOpen, toggle] = groupOpen[g.kind];
          return (
            <div key={g.kind} className="profile-group">
              <button
                className="section-label section-toggle"
                title={isOpen ? `Hide the ${g.label} connections` : `Show the ${g.label} connections`}
                onClick={toggle}
              >
                <span className="section-caret">{isOpen ? "▾" : "▸"}</span> {g.label} ({items.length})
              </button>
              {isOpen &&
                items.map((p) => (
                  <div
                    key={p.id}
                    className="profile-card"
                    title={p.username ? `${p.username}@${p.host}` : p.host}
                    onClick={() => onOpen(p)}
                  >
                    <span className="session-kind">{g.label}</span>
                    <span className="profile-title">{p.name}</span>
                    <button
                      className="profile-btn"
                      title="Edit"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(p);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="profile-btn delete"
                      title="Delete"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(p.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
    </div>
  );
}
