//! Bridges the local OS clipboard and the RDP sessions' clipboards (text only).
//!
//! With 20+ sessions open at once, only the visible (active) session is synchronized.
//! - Local -> remote: when a session comes to the front (the remote screen gets focus),
//!   the local text is handed to that session.
//! - Remote -> local: only text copied in the active session goes to the local clipboard.
//!   Copies made in background sessions are ignored (the local clipboard is never
//!   overwritten behind the user's back).
//!
//! arboard hides the OS differences (Windows / macOS / X11 on Linux;
//! on GNOME under Wayland the sync goes through XWayland).

use std::sync::{
    atomic::{AtomicU32, Ordering},
    LazyLock, Mutex,
};

/// Value meaning "no active RDP session"
const NONE: u32 = u32::MAX;

static ACTIVE: AtomicU32 = AtomicU32::new(NONE);

/// On Linux (X11) the clipboard contents can only be handed to other apps while the
/// owning clipboard object is alive, so keep a single one for the whole process lifetime.
static CLIPBOARD: LazyLock<Mutex<Option<arboard::Clipboard>>> =
    LazyLock::new(|| Mutex::new(arboard::Clipboard::new().ok()));

/// Set the active RDP session (None means something other than RDP, such as a console, is shown).
pub fn set_active(id: Option<u32>) {
    ACTIVE.store(id.unwrap_or(NONE), Ordering::Relaxed);
}

/// Text on the local clipboard (None if there is none). Newlines are converted to CRLF for the remote side.
pub fn local_text() -> Option<String> {
    let text = CLIPBOARD.lock().unwrap().as_mut()?.get_text().ok()?;
    Some(to_crlf(&text))
}

/// Put text copied in session `id` on the local clipboard, if that session is the active one.
pub fn from_remote(id: u32, text: &str) {
    if ACTIVE.load(Ordering::Relaxed) != id {
        return;
    }
    let text = if cfg!(windows) { text.to_owned() } else { text.replace("\r\n", "\n") };
    if let Some(clipboard) = CLIPBOARD.lock().unwrap().as_mut() {
        if let Err(e) = clipboard.set_text(text) {
            tracing::warn!("Could not write to the local clipboard: {e}");
        }
    }
}

/// Normalize newlines to CRLF (the convention for Windows CF_UNICODETEXT)
fn to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newlines_become_crlf_once() {
        assert_eq!(to_crlf("a\nb\r\nc"), "a\r\nb\r\nc");
    }
}
