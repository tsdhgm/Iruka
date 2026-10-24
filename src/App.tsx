import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import { resolutionSize, type MemoryBudget, type MemoryCheck, type RdpConnectParams, type RdpConnectRequest } from "./rdp";
import { drawThumb, type SessionCallbacks, type SessionHandle, type SessionInfo } from "./session";
import { createPtySession } from "./ptySession";
import { applyPixelSize, createRdpSession, isScaledDisplay, setScaledDisplay } from "./rdpSession";
import { useWindowViewToggleKey } from "./hostKey";
import {
  buildSshCommand,
  loadProfiles,
  rdpParamsFromProfile,
  removeProfile,
  upsertProfile,
  type Profile,
  type RdpProfile,
  type SshProfile,
  type SshTarget,
} from "./profiles";
import { forgetPassword, loadPassword, storePassword } from "./credentials";
import {
  loadLastWorkset,
  loadWorksets,
  newWorksetId,
  removeWorkset,
  saveLastWorkset,
  upsertWorkset,
  type Workset,
} from "./worksets";
import { ActivityBadge } from "./components/ActivityBadge";
import { ConnectWarningModal, type ConnectWarning } from "./components/ConnectWarning";
import { GridView, GRID_MAX_COLS, useMainAreaWidth } from "./components/GridView";
import { RdpForm } from "./components/RdpForm";
import { RestoreReportModal, type RestoreReport } from "./components/RestoreReport";
import { SshForm } from "./components/SshForm";
import { ViewToolbar } from "./components/ViewToolbar";
import { WorksetSection } from "./components/WorksetSection";

/** How long a restored RDP session may take to connect before the next one is started. */
const RESTORE_CONNECT_TIMEOUT_MS = 20_000;

const THUMB_W = 196;
const THUMB_H = 110;
const ZOOM_W = 560;
const ZOOM_H = 330;

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showThumbs, setShowThumbs] = useState<boolean>(
    () => localStorage.getItem("iruka.showThumbs") !== "0",
  );
  // The "Saved" list folds away so it is not clicked by mistake once many sessions are open.
  const [savedOpen, setSavedOpen] = useState<boolean>(
    () => localStorage.getItem("iruka.savedOpen") === "1",
  );
  const handlesRef = useRef<Map<number, SessionHandle>>(new Map());
  const mainRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  const thumbsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const dirtyRef = useRef<Set<number>>(new Set());
  const [zoom, setZoom] = useState<{ id: number; top: number } | null>(null);
  const zoomRef = useRef<{ id: number; top: number } | null>(null);
  zoomRef.current = zoom;
  const zoomCanvasRef = useRef<HTMLCanvasElement>(null);
  // The connect form in the sidebar; only one is open at a time. `initial` is the saved
  // connection being edited or connected to.
  const [form, setForm] = useState<
    { kind: "rdp"; initial?: RdpProfile } | { kind: "ssh"; initial?: SshProfile } | null
  >(null);
  // Saved connections (see profiles.ts); never hold a password.
  const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
  // Pre-connect confirmation (connecting to this machine, not enough free memory); holds the pending connection.
  const [connectWarning, setConnectWarning] = useState<ConnectWarning | null>(null);
  // Worksets (see worksets.ts): named sets of saved connections, plus the set open most recently.
  const [worksets, setWorksets] = useState<Workset[]>(loadWorksets);
  const [lastWorkset, setLastWorkset] = useState<Workset | null>(loadLastWorkset);
  // Name of the workset being restored (one at a time), and the report shown when it is done.
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  // While restoring: sessions whose first "running" / "exited" status is awaited before the next connect.
  const pendingRef = useRef<Map<number, () => void>>(new Map());
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarPinned, setToolbarPinned] = useState(false);
  const [scaled, setScaled] = useState(isScaledDisplay);
  // Right pane: one session shown large (single) or all sessions as tiles (grid).
  const [view, setView] = useState<"single" | "grid">("single");
  const viewRef = useRef<"single" | "grid">("single");
  viewRef.current = view;
  const [gridCols, setGridCols] = useState<number>(() => {
    const n = Number(localStorage.getItem("iruka.gridCols"));
    return n >= 1 && n <= GRID_MAX_COLS ? n : 3;
  });
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const gridCanvasRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  // When each session last produced output (console) or a screen update (RDP); used for the running/idle badge.
  const lastActivityRef = useRef<Map<number, number>>(new Map());
  // Counter that periodically re-renders the idle-time display.
  const [, setTick] = useState(0);

  const drawZoom = useCallback(() => {
    const z = zoomRef.current;
    const canvas = zoomCanvasRef.current;
    if (!z || !canvas) return;
    const handle = handlesRef.current.get(z.id);
    if (handle) drawThumb(handle, canvas, ZOOM_W, ZOOM_H);
  }, []);

  const showSession = useCallback((id: number) => {
    const grid = viewRef.current === "grid";
    for (const [sid, handle] of handlesRef.current) {
      handle.container.style.display = !grid && sid === id ? "" : "none";
    }
    if (grid) {
      // No RDP session is shown in the grid, so do not bring remote copies into the local clipboard.
      invoke("rdp_set_active", { id: null }).catch(() => {});
      return;
    }
    const handle = handlesRef.current.get(id);
    if (handle) {
      requestAnimationFrame(() => {
        if (handle.kind === "pty") {
          handle.fit.fit();
          handle.term.focus();
          // While something other than RDP is shown, do not bring remote copies into the local clipboard.
          invoke("rdp_set_active", { id: null }).catch(() => {});
        } else {
          applyPixelSize(handle.canvas); // the viewport may have changed while it was hidden
          handle.canvas.focus();
          // The canvas was hidden; WebKit may have dropped its contents, so ask for a full frame.
          invoke("rdp_refresh", { id }).catch(() => {});
        }
      });
    }
  }, []);

  const focusSession = useCallback(
    (id: number) => {
      setActiveId(id);
      showSession(id);
    },
    [showSession],
  );

  const updateSession = useCallback(
    (id: number, patch: Partial<SessionInfo>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
      if (patch.status === "running" || patch.status === "exited") {
        const resolve = pendingRef.current.get(id);
        if (resolve) {
          pendingRef.current.delete(id);
          resolve();
        }
      }
    },
    [],
  );

  /** Toggle between the grid and the single-session view (fullscreen state is kept). */
  const toggleView = useCallback(() => {
    setView((v) => (v === "grid" ? "single" : "grid"));
  }, []);
  const toggleViewRef = useRef(toggleView);
  toggleViewRef.current = toggleView;

  // What a running session needs from the app (see SessionCallbacks).
  const sessionCallbacks = useRef<SessionCallbacks>({
    toggleView: () => toggleViewRef.current(),
    markDirty: (id) => dirtyRef.current.add(id),
    markActivity: (id) => lastActivityRef.current.set(id, Date.now()),
    updateSession: (id, patch) => updateSession(id, patch),
  }).current;

  /**
   * Open a local shell as a new session. `initialInput` is typed into the shell right
   * away, the same way keystrokes are; the PTY buffers it until the shell reads it.
   */
  const openShell = useCallback(
    async (title?: string, initialInput?: string, profileId?: string, autoPassword?: string) => {
      const main = mainRef.current;
      if (!main) return;
      const created = await createPtySession(main, sessionCallbacks, autoPassword);
      if (!created) return;
      const { id, handle } = created;
      if (initialInput) invoke("write_session", { id, data: initialInput }).catch(() => {});

      handlesRef.current.set(id, handle);
      dirtyRef.current.add(id);
      setSessions((prev) => [
        ...prev,
        {
          id,
          kind: "pty",
          profileId,
          title: title ?? `console ${id + 1}`,
          status: "running",
          exitCode: null,
          message: null,
        },
      ]);
      focusSession(id);
    },
    [focusSession, sessionCallbacks],
  );

  const openConsole = useCallback(() => openShell(), [openShell]);

  /**
   * Open a console and type `ssh [-p PORT] [USER@]HOST` into it. The host-key prompt is
   * answered by the user in the terminal; so is the password prompt, unless `password` is
   * given, which is then typed at the first prompt. Values that are not plain tokens are
   * ignored (the forms refuse them before getting here).
   */
  const openSsh = useCallback(
    (target: SshTarget, profileId?: string, password?: string) => {
      const command = buildSshCommand(target);
      if (!command) return;
      return openShell(target.name || `ssh ${target.host}`, `${command}\r`, profileId, password || undefined);
    },
    [openShell],
  );

  /**
   * Apply a form's "Save password" choice for a saved connection: store the typed password,
   * or fall back to the stored one when the field was left empty, or forget it when the box
   * is off. Returns the password to connect with.
   */
  const settlePassword = useCallback(async (stored: Profile, typed: string): Promise<string> => {
    if (stored.savePassword) {
      if (typed) {
        const error = await storePassword(stored.id, typed);
        if (error) alert(`The password was not saved in the credential store: ${error}`);
        return typed;
      }
      // Empty field with "Save password" on: use the stored one.
      return (await loadPassword(stored.id)) ?? "";
    }
    // "Save password" is off (or was just turned off): make sure nothing stays stored.
    forgetPassword(stored.id);
    return typed;
  }, []);

  const openRdp = useCallback(
    async (request: RdpConnectRequest): Promise<number | null> => {
      const main = mainRef.current;
      if (!main) return null;
      // The title and profile id are for the session list only; `rdp_connect` gets exactly RdpConnectParams.
      const { title, profileId, ...params } = request;
      const created = await createRdpSession(main, params, sessionCallbacks);
      if (!created) return null;
      const { id, handle } = created;

      handlesRef.current.set(id, handle);
      dirtyRef.current.add(id);
      setSessions((prev) => [
        ...prev,
        {
          id,
          kind: "rdp",
          profileId,
          title: title ?? params.host,
          status: "connecting",
          exitCode: null,
          message: null,
        },
      ]);
      focusSession(id);
      return id;
    },
    [focusSession, sessionCallbacks],
  );

  /**
   * Run the pre-connect checks, then connect. When a check stops the connection, the
   * dialog's "Connect anyway" calls this again with that check skipped. Every check is
   * best-effort: if it cannot be performed, the connection still goes ahead.
   */
  const connectWithChecks = useCallback(
    async (params: RdpConnectRequest, skip: { self?: boolean; memory?: boolean }) => {
      if (!skip.self) {
        try {
          if (await invoke<boolean>("rdp_is_self", { host: params.host, port: params.port })) {
            setConnectWarning({ kind: "self", params });
            return;
          }
        } catch {
          // If it cannot be determined, continue without the confirmation.
        }
      }
      if (!skip.memory) {
        try {
          const check = await invoke<MemoryCheck>("rdp_memory_check", {
            width: params.width,
            height: params.height,
          });
          if (check.availableBytes < check.estimatedBytes) {
            setConnectWarning({ kind: "memory", params, check });
            return;
          }
        } catch {
          // Still allow connecting when the check cannot be performed.
        }
      }
      openRdp(params);
    },
    [openRdp],
  );

  /** Store the profile; returns it as stored (the id may be an existing entry's). */
  const saveProfile = useCallback((profile: Profile): Profile => {
    const { profiles, stored } = upsertProfile(profile);
    setProfiles(profiles);
    return stored;
  }, []);

  const deleteProfile = useCallback((id: string) => {
    setProfiles(removeProfile(id));
    forgetPassword(id);
  }, []);

  const submitRdpForm = useCallback(
    async (params: RdpConnectParams, profile: RdpProfile | null) => {
      setForm(null);
      const stored = profile ? saveProfile(profile) : null;
      const password = stored ? await settlePassword(stored, params.password) : params.password;
      connectWithChecks({ ...params, password, title: stored?.name, profileId: stored?.id }, {});
    },
    [connectWithChecks, saveProfile, settlePassword],
  );

  const submitSshForm = useCallback(
    async (target: SshTarget, profile: SshProfile | null, typedPassword: string) => {
      setForm(null);
      const stored = profile ? saveProfile(profile) : null;
      const password = stored ? await settlePassword(stored, typedPassword) : typedPassword;
      openSsh(target, stored?.id, password);
    },
    [openSsh, saveProfile, settlePassword],
  );

  /** "Save" on the SSH form: keep the entry (and the password, when asked) without connecting. */
  const saveSshForm = useCallback(
    async (profile: SshProfile, typedPassword: string) => {
      setForm(null);
      await settlePassword(saveProfile(profile), typedPassword);
    },
    [saveProfile, settlePassword],
  );

  /** Edit a saved connection, or (when `connect`) connect to it. */
  const openProfile = useCallback(
    async (profile: Profile, connect: boolean) => {
      if (profile.kind === "ssh" && connect) {
        setForm(null);
        const password = profile.savePassword ? await loadPassword(profile.id) : null;
        openSsh(profile, profile.id, password ?? undefined);
        return;
      }
      if (profile.kind === "rdp" && connect && profile.savePassword) {
        // With a stored password the connection starts right away; otherwise the form asks for it.
        const password = await loadPassword(profile.id);
        if (password !== null) {
          setForm(null);
          connectWithChecks(
            { ...rdpParamsFromProfile(profile, password), title: profile.name, profileId: profile.id },
            {},
          );
          return;
        }
      }
      setForm(profile.kind === "rdp" ? { kind: "rdp", initial: profile } : { kind: "ssh", initial: profile });
    },
    [connectWithChecks, openSsh],
  );

  const changeGridCols = useCallback((cols: number) => {
    setGridCols(cols);
    localStorage.setItem("iruka.gridCols", String(cols));
    for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
  }, []);

  /** The open sessions that came from saved connections, as a workset (layout included). */
  const currentWorkset = useCallback(
    (name: string, id: string): Workset => ({
      id,
      name,
      savedAt: new Date().toISOString(),
      view,
      gridCols,
      profileIds: sessions.flatMap((s) => (s.profileId ? [s.profileId] : [])),
    }),
    [sessions, view, gridCols],
  );

  const saveWorkset = useCallback(
    (name: string) => {
      setWorksets(upsertWorkset(currentWorkset(name, newWorksetId())));
    },
    [currentWorkset],
  );

  const deleteWorkset = useCallback((id: string) => {
    setWorksets(removeWorkset(id));
  }, []);

  // Remember the set of sessions open right now (saved connections only) as "Last open sessions".
  useEffect(() => {
    if (!sessions.some((s) => s.profileId)) return;
    const timer = setTimeout(() => {
      const ws = currentWorkset("Last open sessions", "last");
      saveLastWorkset(ws);
      setLastWorkset(ws);
    }, 1000);
    return () => clearTimeout(timer);
  }, [sessions, currentWorkset]);

  /**
   * Bring a workset back: the sessions are started one after another (a restored RDP
   * session gets up to RESTORE_CONNECT_TIMEOUT_MS to connect before the next one starts),
   * and only as many RDP sessions as the estimated memory allows, in the saved order.
   * The rest, and the ones without a stored password, are listed in the report.
   */
  const restoreWorkset = useCallback(
    async (workset: Workset) => {
      if (restoring !== null) return;
      setRestoring(workset.name);
      setForm(null);
      const report: RestoreReport = {
        workset: workset.name,
        restored: [],
        skippedMemory: [],
        skippedNoPassword: [],
        missing: 0,
        availableBytes: null,
        learned: false,
      };
      try {
        const byId = new Map(profiles.map((p) => [p.id, p]));
        const items: Profile[] = [];
        for (const id of workset.profileIds) {
          const p = byId.get(id);
          if (p) items.push(p);
          else report.missing++;
        }
        // Which RDP sessions fit: add up the estimates in order, stop including at the first that does not.
        const rdpItems = items.filter((p): p is RdpProfile => p.kind === "rdp");
        const fits = new Set<string>(rdpItems.map((p) => p.id));
        if (rdpItems.length > 0) {
          try {
            const sizes = rdpItems.map((p) => {
              const { width, height } = resolutionSize(p.resolution);
              return [width, height] as [number, number];
            });
            const budget = await invoke<MemoryBudget>("rdp_memory_budget", { sizes });
            report.availableBytes = budget.availableBytes;
            report.learned = budget.learned;
            let used = 0;
            rdpItems.forEach((p, i) => {
              const need = budget.estimatedBytes[i] ?? 0;
              if (used + need <= budget.availableBytes) used += need;
              else fits.delete(p.id);
            });
          } catch {
            // Without an estimate, restore everything.
          }
        }
        setView(workset.view);
        changeGridCols(workset.gridCols);
        for (const p of items) {
          if (p.kind === "ssh") {
            // Without a stored password the console still opens; ssh asks in the terminal.
            const password = p.savePassword ? await loadPassword(p.id) : null;
            await openSsh(p, p.id, password ?? undefined);
            report.restored.push(p.name);
            continue;
          }
          if (!fits.has(p.id)) {
            report.skippedMemory.push(p.name);
            continue;
          }
          const password = p.savePassword ? await loadPassword(p.id) : null;
          if (password === null) {
            report.skippedNoPassword.push(p.name);
            continue;
          }
          const id = await openRdp({ ...rdpParamsFromProfile(p, password), title: p.name, profileId: p.id });
          if (id === null) continue;
          report.restored.push(p.name);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pendingRef.current.delete(id);
              resolve();
            }, RESTORE_CONNECT_TIMEOUT_MS);
            pendingRef.current.set(id, () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      } finally {
        setRestoring(null);
        setRestoreReport(report);
      }
    },
    [restoring, profiles, openSsh, openRdp, changeGridCols],
  );

  const proceedDespiteWarning = useCallback(
    (warning: ConnectWarning) => {
      if (warning.kind === "self") {
        const { params } = warning;
        setConnectWarning(null);
        connectWithChecks(params, { self: true });
      } else {
        openRdp(warning.params);
        setConnectWarning(null);
      }
    },
    [connectWithChecks, openRdp],
  );

  const toggleFullscreen = useCallback(async (on: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(on);
      setFullscreen(on);
    } catch (e) {
      alert(`Could not toggle fullscreen: ${e}`);
    }
    const id = activeIdRef.current;
    if (id !== null) showSession(id);
  }, [showSession]);

  // F11 toggles full screen and Escape leaves it, whenever the keyboard focus is not in a
  // session (a session stops the events it handles, so they never get here): in the grid, or
  // after clicking the sidebar or the empty area. In a session those keys belong to the remote.
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const toggleFullscreenRef = useRef(toggleFullscreen);
  toggleFullscreenRef.current = toggleFullscreen;
  useEffect(() => {
    const inField = (t: EventTarget | null) =>
      t instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);
    const onKey = (e: KeyboardEvent) => {
      if (inField(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreenRef.current(!fullscreenRef.current);
      } else if (e.key === "Escape" && fullscreenRef.current) {
        e.preventDefault();
        toggleFullscreenRef.current(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Toolbar "Scaled": fit the RDP screens into the view (all sessions) or show them 1:1. */
  const toggleScaled = useCallback((on: boolean) => {
    setScaledDisplay(on);
    setScaled(on);
    for (const h of handlesRef.current.values()) {
      if (h.kind === "rdp") applyPixelSize(h.canvas);
    }
  }, []);

  const closeSession = useCallback((id: number) => {
    if (activeIdRef.current === id) toggleFullscreen(false);
    const handle = handlesRef.current.get(id);
    if (handle) {
      if (handle.kind === "pty") {
        invoke("kill_session", { id }).catch(() => {});
        handle.term.dispose();
      } else {
        invoke("rdp_close", { id }).catch(() => {});
      }
      handle.container.remove();
      handlesRef.current.delete(id);
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeIdRef.current === id) {
        const fallback = next.length > 0 ? next[next.length - 1].id : null;
        setActiveId(fallback);
        if (fallback !== null) {
          showSession(fallback);
        }
      }
      return next;
    });
  }, [showSession, toggleFullscreen]);

  // Every 500ms, redraw the thumbnails (sidebar and grid tiles) of sessions that had output.
  useEffect(() => {
    const iv = setInterval(() => {
      for (const id of dirtyRef.current) {
        const handle = handlesRef.current.get(id);
        const canvas = thumbsRef.current.get(id);
        if (handle && canvas) {
          drawThumb(handle, canvas, THUMB_W, THUMB_H);
        }
        const tile = gridCanvasRef.current.get(id);
        if (handle && tile) {
          drawThumb(handle, tile, tile.clientWidth, tile.clientHeight);
        }
        dirtyRef.current.delete(id);
      }
      drawZoom();
      setTick((t) => t + 1);
    }, 500);
    return () => clearInterval(iv);
  }, [drawZoom]);

  // When the grid view is toggled: update which session is shown and draw every tile.
  useEffect(() => {
    const id = activeIdRef.current;
    if (id !== null) showSession(id);
    if (view === "grid") {
      for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
    }
  }, [view, showSession]);

  // Width of the right pane (used to compute the tile size).
  const markAllDirty = useCallback(() => {
    for (const sid of handlesRef.current.keys()) dirtyRef.current.add(sid);
  }, []);
  const mainWidth = useMainAreaWidth(mainAreaRef, markAllDirty);

  // View-toggle key while no session has focus (e.g. in the grid view).
  useWindowViewToggleKey(toggleViewRef);

  useEffect(() => {
    drawZoom();
  }, [zoom, drawZoom]);

  useEffect(() => {
    const onWindowResize = () => {
      const id = activeIdRef.current;
      if (id === null) return;
      const handle = handlesRef.current.get(id);
      if (handle?.kind === "pty") handle.fit.fit();
      // If the display scale or the viewport changed (another monitor, fullscreen, sidebar), re-apply the size.
      for (const h of handlesRef.current.values()) {
        if (h.kind === "rdp") applyPixelSize(h.canvas);
      }
      // Also follow along when the window manager left fullscreen on its own.
      getCurrentWindow()
        .isFullscreen()
        .then(setFullscreen)
        .catch(() => {});
    };
    // After copying in another app and coming back, hand the clipboard to the RDP session being shown.
    const onWindowFocus = () => {
      const id = activeIdRef.current;
      if (id !== null && handlesRef.current.get(id)?.kind === "rdp") {
        invoke("rdp_set_active", { id }).catch(() => {});
      }
    };
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className={`app ${fullscreen ? "fullscreen" : ""}`}>
      <aside className="sidebar">
        <div className="brand">🐬 Iruka</div>
        <div className="connect-form">
          <button className="new-console-btn" onClick={() => openConsole()}>
            + Console
          </button>
          <button
            className="new-console-btn"
            onClick={() => setForm((f) => (f?.kind === "rdp" ? null : { kind: "rdp" }))}
          >
            + RDP
          </button>
          <button
            className="thumb-toggle"
            title={
              showThumbs ? "Show names only" : "Show thumbnails"
            }
            onClick={() =>
              setShowThumbs((v) => {
                const next = !v;
                localStorage.setItem("iruka.showThumbs", next ? "1" : "0");
                return next;
              })
            }
          >
            {showThumbs ? "☰" : "🖼"}
          </button>
          <button
            className="new-console-btn new-ssh-btn"
            onClick={() => setForm((f) => (f?.kind === "ssh" ? null : { kind: "ssh" }))}
          >
            + SSH
          </button>
        </div>
        {form?.kind === "rdp" && (
          <RdpForm
            key={form.initial?.id ?? "new"}
            initial={form.initial}
            onConnect={submitRdpForm}
            onSave={(p) => {
              saveProfile(p);
              setForm(null);
            }}
            onCancel={() => setForm(null)}
          />
        )}
        {form?.kind === "ssh" && (
          <SshForm
            key={form.initial?.id ?? "new"}
            initial={form.initial}
            onConnect={submitSshForm}
            onSave={saveSshForm}
            onCancel={() => setForm(null)}
          />
        )}
        <div className="session-list">
          {profiles.length > 0 && (
            <div className="profile-section">
              <button
                className="section-label section-toggle"
                title={savedOpen ? "Hide saved connections" : "Show saved connections"}
                onClick={() =>
                  setSavedOpen((v) => {
                    const next = !v;
                    localStorage.setItem("iruka.savedOpen", next ? "1" : "0");
                    return next;
                  })
                }
              >
                <span className="section-caret">{savedOpen ? "▾" : "▸"}</span> Saved ({profiles.length})
              </button>
              {savedOpen && profiles.map((p) => (
                <div
                  key={p.id}
                  className="profile-card"
                  title={p.username ? `${p.username}@${p.host}` : p.host}
                  onClick={() => openProfile(p, true)}
                >
                  <span className="session-kind">{p.kind === "rdp" ? "RDP" : "SSH"}</span>
                  <span className="profile-title">{p.name}</span>
                  <button
                    className="profile-btn"
                    title="Edit"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      openProfile(p, false);
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
                      deleteProfile(p.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {(profiles.length > 0 || worksets.length > 0 || lastWorkset) && (
            <WorksetSection
              worksets={worksets}
              last={lastWorkset}
              canSave={sessions.some((s) => s.profileId)}
              restoring={restoring}
              onSave={saveWorkset}
              onRestore={restoreWorkset}
              onDelete={deleteWorkset}
            />
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-card ${s.id === activeId ? "active" : ""}`}
              onClick={() => focusSession(s.id)}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const top = Math.max(
                  8,
                  Math.min(rect.top, window.innerHeight - ZOOM_H - 8),
                );
                setZoom({ id: s.id, top });
              }}
              onMouseLeave={() => setZoom(null)}
            >
              <div className="session-card-header">
                <span className={`status-dot ${s.status}`} />
                <span className="session-kind">
                  {s.kind === "rdp" ? "RDP" : ">_"}
                </span>
                <span className="session-title" title={s.message ?? undefined}>
                  {s.title}
                </span>
                <ActivityBadge session={s} lastActivity={lastActivityRef.current.get(s.id)} />
                <button
                  className="close-btn"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setZoom(null);
                    closeSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
              {showThumbs && (
                <canvas
                  className="thumb"
                  ref={(el) => {
                    if (el) {
                      thumbsRef.current.set(s.id, el);
                      dirtyRef.current.add(s.id);
                    } else {
                      thumbsRef.current.delete(s.id);
                    }
                  }}
                />
              )}
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="empty-hint">
              No sessions yet.
              <br />
              Open one with "+ Console", "+ SSH" or "+ RDP".
            </div>
          )}
        </div>
      </aside>
      <div className="main-area" ref={mainAreaRef}>
        <main className="main" ref={mainRef}>
          {sessions.length === 0 && (
            <div className="placeholder">
              <div className="placeholder-logo">🐬</div>
              <p>Iruka — console &amp; desktop fleet viewer</p>
            </div>
          )}
        </main>
        {view === "grid" && (
          <GridView
            sessions={sessions}
            activeId={activeId}
            gridCols={gridCols}
            mainWidth={mainWidth}
            gridCanvasRef={gridCanvasRef}
            dirtyRef={dirtyRef}
            lastActivityRef={lastActivityRef}
            onSelect={(id) => {
              setView("single");
              focusSession(id);
            }}
          />
        )}
        {sessions.length > 0 && (
          <ViewToolbar
            view={view}
            sessionCount={sessions.length}
            activeSession={activeSession}
            gridCols={gridCols}
            pinned={toolbarPinned}
            fullscreen={fullscreen}
            scaled={scaled}
            onToggleView={toggleView}
            onChangeGridCols={changeGridCols}
            onTogglePinned={() => setToolbarPinned((v) => !v)}
            onToggleFullscreen={toggleFullscreen}
            onToggleScaled={toggleScaled}
            onClose={closeSession}
          />
        )}
      </div>
      {restoreReport && <RestoreReportModal report={restoreReport} onClose={() => setRestoreReport(null)} />}
      {connectWarning && (
        <ConnectWarningModal
          warning={connectWarning}
          onCancel={() => setConnectWarning(null)}
          onProceed={proceedDespiteWarning}
        />
      )}
      {zoom !== null && (
        <div className="zoom-overlay" style={{ top: zoom.top }}>
          <canvas ref={zoomCanvasRef} className="zoom-canvas" />
        </div>
      )}
    </div>
  );
}

export default App;
