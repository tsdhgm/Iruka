/** What happened when a workset was restored (shown once the last session was started). */
export interface RestoreReport {
  workset: string;
  /** Sessions that were started (saved-connection names). */
  restored: string[];
  /** RDP sessions left out because the estimated memory did not fit. */
  skippedMemory: string[];
  /** RDP sessions left out because no password is stored for them. */
  skippedNoPassword: string[];
  /** Entries whose saved connection no longer exists. */
  missing: number;
  /** Memory available when the restore started, and whether the estimate was learned. */
  availableBytes: number | null;
  learned: boolean;
}

const formatMb = (bytes: number) => `${Math.round(bytes / 1048576).toLocaleString()} MB`;

export function RestoreReportModal({ report, onClose }: { report: RestoreReport; onClose: () => void }) {
  const partial = report.skippedMemory.length > 0 || report.skippedNoPassword.length > 0 || report.missing > 0;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{partial ? "Workset restored in part" : "Workset restored"}</h2>
        <p>
          {report.workset}: {report.restored.length} of{" "}
          {report.restored.length + report.skippedMemory.length + report.skippedNoPassword.length + report.missing}{" "}
          sessions started.
        </p>
        {report.skippedMemory.length > 0 && (
          <p>
            Not started, memory would run short
            {report.availableBytes !== null ? ` (about ${formatMb(report.availableBytes)} was available)` : ""}:{" "}
            {report.skippedMemory.join(", ")}.
          </p>
        )}
        {report.skippedNoPassword.length > 0 && (
          <p>
            Not started, no saved password (connect from the Saved list and tick "Save password"):{" "}
            {report.skippedNoPassword.join(", ")}.
          </p>
        )}
        {report.missing > 0 && (
          <p>
            {report.missing} saved connection{report.missing === 1 ? "" : "s"} of this workset no longer exist
            {report.missing === 1 ? "s" : ""}.
          </p>
        )}
        {report.skippedMemory.length > 0 && (
          <p className="modal-note">
            {report.learned
              ? "The memory estimate is learned from past sessions."
              : "No usage has been learned yet, so the estimate uses the default."}{" "}
            Close other programs or lower the resolution of some saved connections, then restore again; sessions
            that are already open are kept.
          </p>
        )}
        <div className="modal-buttons">
          <button onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}
