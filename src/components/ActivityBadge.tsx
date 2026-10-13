import type { SessionInfo } from "../session";

/** Output within this many ms counts as "running" (spinners such as Claude Code's print continuously). */
const RUNNING_WINDOW_MS = 2000;

/** Format an idle duration (e.g. 45s / 3m / 2h). */
function formatIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * Shows whether a console is running or idle.
 * The state of the command on the far side of ssh is not known directly, so it is
 * judged by whether output keeps coming. A command that works without printing
 * looks "idle", which is good enough for watching AI agents.
 */
export function ActivityBadge({
  session,
  lastActivity,
}: {
  session: SessionInfo;
  lastActivity: number | undefined;
}) {
  if (session.kind !== "pty") return null;
  if (session.status === "exited") return <span className="badge exited">Exited</span>;
  const idle = Date.now() - (lastActivity ?? 0);
  if (idle < RUNNING_WINDOW_MS) return <span className="badge running">Running</span>;
  return (
    <span className="badge idle" title="Time since the last output">
      Idle {formatIdle(idle)}
    </span>
  );
}
