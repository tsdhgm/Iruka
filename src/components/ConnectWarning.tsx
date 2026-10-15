import type { MemoryCheck, RdpConnectRequest } from "../rdp";

/** A pre-connect check that stopped the connection; holds the pending connection parameters. */
export type ConnectWarning =
  | { kind: "self"; params: RdpConnectRequest }
  | { kind: "memory"; params: RdpConnectRequest; check: MemoryCheck };

const formatMb = (bytes: number) => `${Math.round(bytes / 1048576).toLocaleString()} MB`;

/**
 * Confirmation dialogs shown before an RDP connection: connecting to this very
 * machine, and not enough free memory. `onProceed` is called when the user
 * chooses to connect anyway.
 */
export function ConnectWarningModal({
  warning,
  onCancel,
  onProceed,
}: {
  warning: ConnectWarning;
  onCancel: () => void;
  onProceed: (warning: ConnectWarning) => void;
}) {
  if (warning.kind === "self") {
    return (
      <div className="modal-backdrop">
        <div className="modal" role="dialog" aria-modal="true">
          <h2>This is the local machine</h2>
          <p>
            {warning.params.host} resolves to the computer that is running Iruka.
          </p>
          <p className="modal-note">
            Connecting to your own screen share moves the real cursor every time you move
            the mouse inside the remote screen; it gets pulled toward the top-left corner
            and you lose track of it. If you meant to connect to another computer, press
            Cancel and check the address.
          </p>
          <div className="modal-buttons">
            <button onClick={onCancel}>Cancel</button>
            <button className="danger" onClick={() => onProceed(warning)}>
              Connect anyway
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <h2>Memory may run short</h2>
        <p>
          Connecting to {warning.params.host} ({warning.params.width}×
          {warning.params.height}) is expected to need about{" "}
          {formatMb(warning.check.estimatedBytes)}. About{" "}
          {formatMb(warning.check.availableBytes)} of memory is available.
        </p>
        <p className="modal-note">
          {warning.check.learned
            ? `The estimate is learned from past sessions (${warning.check.scale.toFixed(2)}× the default).`
            : "No usage has been learned yet, so the estimate uses the default."}{" "}
          Connecting may make the system slow or unstable. A lower resolution needs less
          memory.
        </p>
        <div className="modal-buttons">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={() => onProceed(warning)}>
            Connect anyway
          </button>
        </div>
      </div>
    </div>
  );
}
