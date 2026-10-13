import { useEffect, type RefObject } from "react";

/**
 * View-toggle key (KeyboardEvent.code). Pressing and releasing it on its own
 * switches between the grid and the single-session view.
 * Defaults to right Alt (for keyboards without a right Ctrl). Read once at startup.
 */
export const VIEW_TOGGLE_KEY = localStorage.getItem("iruka.viewToggleKey") || "AltRight";
export const VIEW_TOGGLE_LABEL = VIEW_TOGGLE_KEY === "AltRight" ? "Right Alt" : VIEW_TOGGLE_KEY;

/**
 * Tracks the view-toggle key.
 * Nothing happens on press; the view toggles only when the key is released
 * without any other key having been pressed in between. If another key is
 * pressed while it is held, it acts as an ordinary modifier (and only then is
 * the key-down sent). When keydown / keyup return true, the caller must not
 * process that event any further.
 */
export function hostKeyTracker(
  code: string,
  on: { toggle: () => void; sendDown: () => void; sendUp: () => void },
) {
  let pending = false; // pressed, but the key-down has not been sent yet
  let sent = false; // another key was pressed, so the key-down has been sent
  return {
    keydown(e: KeyboardEvent): boolean {
      if (e.code === code) {
        if (!e.repeat && !pending && !sent) pending = true;
        return true;
      }
      if (pending) {
        pending = false;
        sent = true;
        on.sendDown();
      }
      return false;
    },
    keyup(e: KeyboardEvent): boolean {
      if (e.code !== code) return false;
      if (pending) {
        pending = false;
        on.toggle();
      } else if (sent) {
        sent = false;
        on.sendUp();
      }
      return true;
    },
    reset() {
      pending = false;
      sent = false;
    },
  };
}

/**
 * View-toggle key for when no session has focus (e.g. while the grid is shown).
 * Events already handled by a session are stopped with stopPropagation, so they
 * never reach this listener.
 */
export function useWindowViewToggleKey(toggleViewRef: RefObject<() => void>) {
  useEffect(() => {
    const hostKey = hostKeyTracker(VIEW_TOGGLE_KEY, {
      toggle: () => toggleViewRef.current(),
      sendDown: () => {},
      sendUp: () => {},
    });
    const inField = (t: EventTarget | null) =>
      t instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);
    const onDown = (e: KeyboardEvent) => {
      if (inField(e.target)) return;
      if (hostKey.keydown(e)) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      if (inField(e.target)) return;
      if (hostKey.keyup(e)) e.preventDefault();
    };
    const onBlur = () => hostKey.reset();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [toggleViewRef]);
}
