//! Common parts of RDP sessions.
//!
//! Communication with the frontend (Tauri commands and events), session management,
//! and batching screen changes for the frontend live here; the connection itself is
//! left to a backend (FreeRDP / IronRDP). A backend can be swapped in by implementing
//! the [`RdpBackend`] trait.

#[cfg(feature = "freerdp")]
mod freerdp;
#[cfg(feature = "ironrdp")]
mod ironrdp;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::{clipboard, memory, NEXT_SESSION_ID};

/// Minimum interval between frames sent to the frontend (about 30fps).
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Maximum number of pending dirty rectangles. Beyond this they are collapsed into a single rectangle.
pub const MAX_DIRTY_RECTS: usize = 128;

/// Events from the backend to the frontend (pixel data goes over a separate Channel as binary).
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RdpEvent {
    /// Connected, or the server changed the screen size.
    #[serde(rename_all = "camelCase")]
    Resize { width: u32, height: u32 },
    #[serde(rename_all = "camelCase")]
    Closed {
        reason: String,
        error: bool,
        backend: &'static str,
    },
    /// A cursor shape from the server (sent once per shape; `Cursor` then selects it by id).
    /// `rgba` is base64 of width * height * 4 bytes, R, G, B, A.
    #[serde(rename_all = "camelCase")]
    CursorImage {
        id: u32,
        width: u32,
        height: u32,
        hot_x: u32,
        hot_y: u32,
        rgba: String,
    },
    /// Which cursor to show: None hides it, Some(0) is the local default arrow, any other
    /// id refers to an earlier `CursorImage`.
    Cursor { id: Option<u32> },
}

/// A cursor shape received from the server, as the backend hands it to [`FrameSink::cursor_image`].
pub struct CursorImage {
    pub id: u32,
    pub width: u32,
    pub height: u32,
    pub hot_x: u32,
    pub hot_y: u32,
    /// width * height * 4 bytes, R, G, B, A
    pub rgba: Vec<u8>,
}

/// Input from the frontend. Coordinates are pixels on the remote screen.
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RdpInput {
    MouseMove { x: u16, y: u16 },
    /// button is the MouseEvent.button value (0=left, 1=middle, 2=right, 3/4=back/forward)
    MouseButton { button: u8, down: bool },
    /// units: one notch = 120, positive is up (or right)
    Wheel { vertical: bool, units: i16 },
    /// scancode is PC/AT Set 1; extended keys are 0xE0xx
    Key { scancode: u16, down: bool },
    ReleaseAll,
}

/// Instructions sent to the session thread.
pub enum Command {
    Input(Vec<RdpInput>),
    /// Announce the local clipboard text (None means empty) to the remote side
    ClipboardLocal(Option<String>),
    /// Resend the whole screen (the frontend lost or hid its copy of the frame)
    Refresh,
    Close,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackendKind {
    /// Pick whatever is available (FreeRDP preferred)
    #[default]
    Auto,
    Freerdp,
    Ironrdp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConnectParams {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    /// Requested screen size (screen-sharing servers may ignore it)
    pub width: u16,
    pub height: u16,
    #[serde(default)]
    pub backend: BackendKind,
    /// Play remote audio locally (FreeRDP only)
    #[serde(default)]
    pub audio: bool,
    /// Send the local microphone to the remote side (FreeRDP only)
    #[serde(default)]
    pub microphone: bool,
    /// Use a small RDPGFX cache (100MB -> 16MB) (FreeRDP only)
    #[serde(default)]
    pub small_cache: bool,
    /// Share the clipboard (text) (FreeRDP only)
    #[serde(default = "default_true")]
    pub clipboard: bool,
}

fn default_true() -> bool {
    true
}

impl RdpConnectParams {
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(3389)
    }

    /// Also accepts the "DOMAIN\user" form and splits it into (domain, user)
    pub fn domain_and_user(&self) -> (Option<String>, String) {
        match (&self.domain, self.username.split_once('\\')) {
            (Some(d), _) if !d.is_empty() => (Some(d.clone()), self.username.clone()),
            (_, Some((d, u))) => (Some(d.to_owned()), u.to_owned()),
            _ => (None, self.username.clone()),
        }
    }
}

/// An RDP connection method. [`run`](RdpBackend::run) is called on one thread per session.
pub trait RdpBackend: Sync {
    fn name(&self) -> &'static str;

    /// Connect, then keep receiving the screen and sending input until disconnected.
    /// `commands` must be checked periodically; on `Close`, disconnect and return.
    /// On a normal end, returns the reason for the disconnect.
    fn run(
        &self,
        params: &RdpConnectParams,
        commands: &Receiver<Command>,
        sink: &mut FrameSink,
    ) -> anyhow::Result<String>;
}

fn select_backend(kind: BackendKind) -> Result<&'static dyn RdpBackend, String> {
    match kind {
        #[cfg(feature = "freerdp")]
        BackendKind::Auto | BackendKind::Freerdp => Ok(&freerdp::FreeRdp),
        #[cfg(all(feature = "ironrdp", not(feature = "freerdp")))]
        BackendKind::Auto => Ok(&ironrdp::IronRdp),
        #[cfg(feature = "ironrdp")]
        BackendKind::Ironrdp => Ok(&ironrdp::IronRdp),
        #[allow(unreachable_patterns)]
        _ => Err("This RDP backend is not built in".into()),
    }
}

/// Read-only view of a framebuffer. 4 bytes per pixel, in the order R, G, B, (unused).
pub struct FrameView<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

/// A changed region (bottom-right edge exclusive).
#[derive(Clone, Copy)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> u32 {
        self.x + self.width
    }

    fn bottom(&self) -> u32 {
        self.y + self.height
    }

    /// true if the rectangles overlap or touch
    fn touches(&self, o: &Rect) -> bool {
        self.x <= o.right() && o.x <= self.right() && self.y <= o.bottom() && o.y <= self.bottom()
    }

    fn union(&self, o: &Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        Rect {
            x,
            y,
            width: self.right().max(o.right()) - x,
            height: self.bottom().max(o.bottom()) - y,
        }
    }
}

/// Merge rectangles that overlap or touch (separate rectangles stay separate)
fn merge_rects(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut merged = true;
    while merged {
        merged = false;
        let mut i = 0;
        while i < rects.len() {
            let mut j = i + 1;
            while j < rects.len() {
                if rects[i].touches(&rects[j]) {
                    rects[i] = rects[i].union(&rects[j]);
                    rects.swap_remove(j);
                    merged = true;
                } else {
                    j += 1;
                }
            }
            i += 1;
        }
    }
    rects
}

/// Where the backend delivers screen updates.
///
/// Changed regions are accumulated and sent to the frontend in batches at a fixed
/// interval. The send (hand-off to the WebView) happens on a separate thread, so the
/// session thread never waits (input is not delayed). While the sender cannot keep up,
/// regions keep accumulating and the next send delivers the latest screen in one batch.
///
/// Wire format (little-endian):
/// `screen width u32, screen height u32, rect count u32, reserved u32, send time f64 (UNIX milliseconds)`
/// followed, per rectangle, by `x, y, w, h (u32 each)` and `w*h*4` bytes of RGBA pixels.
pub struct FrameSink {
    id: u32,
    events: Channel<RdpEvent>,
    dirty: Vec<Rect>,
    last_sent: Instant,
    /// The sender thread is still delivering the previous batch
    busy: Arc<AtomicBool>,
    frames: Sender<Vec<u8>>,
}

impl FrameSink {
    fn new(id: u32, events: Channel<RdpEvent>, frames: Channel<InvokeResponseBody>) -> Self {
        let busy = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let sender_busy = busy.clone();
        std::thread::spawn(move || {
            for msg in rx {
                let t0 = Instant::now();
                let kb = msg.len() / 1024;
                let _ = frames.send(InvokeResponseBody::Raw(msg));
                tracing::debug!(
                    target: "iruka_perf",
                    kb,
                    send_ms = t0.elapsed().as_secs_f64() * 1000.0,
                    "frame sent"
                );
                sender_busy.store(false, Ordering::Release);
            }
        });
        Self {
            id,
            events,
            dirty: Vec::new(),
            last_sent: Instant::now(),
            busy,
            frames: tx,
        }
    }

    /// The screen size was determined or changed. The frontend rebuilds its canvas.
    pub fn resize(&mut self, width: u32, height: u32) -> anyhow::Result<()> {
        self.dirty.clear();
        memory::set_session_size(self.id, width, height);
        self.events.send(RdpEvent::Resize { width, height })?;
        Ok(())
    }

    /// Text was copied on the remote side (put on the local clipboard if this session is active).
    pub fn clipboard_from_remote(&self, text: &str) {
        clipboard::from_remote(self.id, text);
    }

    /// The server sent a new cursor shape. The frontend keeps it under its id.
    pub fn cursor_image(&self, img: CursorImage) {
        let rgba = base64::engine::general_purpose::STANDARD.encode(&img.rgba);
        let _ = self.events.send(RdpEvent::CursorImage {
            id: img.id,
            width: img.width,
            height: img.height,
            hot_x: img.hot_x,
            hot_y: img.hot_y,
            rgba,
        });
    }

    /// The server selected a cursor (see [`RdpEvent::Cursor`] for the meaning of `id`).
    pub fn cursor(&self, id: Option<u32>) {
        let _ = self.events.send(RdpEvent::Cursor { id });
    }

    /// This region of the screen changed.
    pub fn damage(&mut self, rect: Rect) {
        if rect.width == 0 || rect.height == 0 {
            return;
        }
        if self.dirty.len() >= MAX_DIRTY_RECTS {
            let all = self.dirty.iter().fold(rect, |acc, r| acc.union(r));
            self.dirty.clear();
            self.dirty.push(all);
            return;
        }
        self.dirty.push(rect);
    }

    /// Send the accumulated changes. Unless `force`, only sends once enough time has passed since the last send.
    /// Backends must call this after every round of event processing (periodically even when idle).
    pub fn flush(&mut self, fb: &FrameView, force: bool) -> anyhow::Result<()> {
        if self.dirty.is_empty()
            || self.busy.load(Ordering::Acquire)
            || (!force && self.last_sent.elapsed() < FRAME_INTERVAL)
        {
            return Ok(());
        }
        let t0 = Instant::now();
        let rects: Vec<Rect> = merge_rects(std::mem::take(&mut self.dirty))
            .into_iter()
            .filter_map(|r| {
                // Clip the part that extends beyond the screen
                let right = r.right().min(fb.width);
                let bottom = r.bottom().min(fb.height);
                (right > r.x && bottom > r.y).then(|| Rect {
                    x: r.x,
                    y: r.y,
                    width: right - r.x,
                    height: bottom - r.y,
                })
            })
            .collect();
        if rects.is_empty() {
            return Ok(());
        }

        let pixels: usize = rects.iter().map(|r| r.width as usize * r.height as usize * 4).sum();
        let mut msg = Vec::with_capacity(24 + rects.len() * 16 + pixels);
        let sent_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        for v in [fb.width, fb.height, rects.len() as u32, 0] {
            msg.extend_from_slice(&v.to_le_bytes());
        }
        msg.extend_from_slice(&sent_at.to_le_bytes());
        for r in &rects {
            for v in [r.x, r.y, r.width, r.height] {
                msg.extend_from_slice(&v.to_le_bytes());
            }
            let start = msg.len();
            for row in r.y..r.bottom() {
                let offset = row as usize * fb.stride + r.x as usize * 4;
                msg.extend_from_slice(&fb.data[offset..offset + r.width as usize * 4]);
            }
            // Alpha is always treated as opaque
            for a in msg[start..].iter_mut().skip(3).step_by(4) {
                *a = 0xff;
            }
        }
        tracing::debug!(
            target: "iruka_perf",
            rects = rects.len(),
            kb = msg.len() / 1024,
            copy_ms = t0.elapsed().as_secs_f64() * 1000.0,
            "frame queued"
        );
        self.busy.store(true, Ordering::Release);
        if self.frames.send(msg).is_err() {
            self.busy.store(false, Ordering::Release);
        }
        self.last_sent = Instant::now();
        Ok(())
    }
}

#[derive(Default)]
pub struct RdpState {
    sessions: Arc<Mutex<HashMap<u32, Sender<Command>>>>,
}

#[tauri::command]
pub fn rdp_connect(
    state: tauri::State<'_, RdpState>,
    params: RdpConnectParams,
    on_event: Channel<RdpEvent>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let backend = select_backend(params.backend)?;
    let id = NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    state.sessions.lock().unwrap().insert(id, tx);

    memory::set_session_size(id, params.width.into(), params.height.into());
    let sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let mut sink = FrameSink::new(id, on_event.clone(), on_frame);
        let (reason, error) = match backend.run(&params, &rx, &mut sink) {
            Ok(reason) => (reason, false),
            Err(e) => (format!("{e:#}"), true),
        };
        sessions.lock().unwrap().remove(&id);
        memory::remove_session(id);
        let _ = on_event.send(RdpEvent::Closed {
            reason,
            error,
            backend: backend.name(),
        });
    });

    Ok(id)
}

#[tauri::command]
pub fn rdp_input(state: tauri::State<'_, RdpState>, id: u32, events: Vec<RdpInput>) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let tx = sessions.get(&id).ok_or("session not found")?;
    let keys = events.iter().filter(|e| matches!(e, RdpInput::Key { down: true, .. })).count();
    if keys > 0 {
        tracing::debug!(target: "iruka_perf", keys, total = events.len(), "input received from frontend");
    }
    tx.send(Command::Input(events)).map_err(|e| e.to_string())
}

/// Log performance measurements from the frontend (for diagnostics)
#[tauri::command]
pub fn rdp_perf_log(message: String) {
    tracing::debug!(target: "iruka_perf", "frontend: {message}");
}

/// Whether the target is this PC itself (127.0.0.1, localhost, one of our own IP addresses, our own hostname).
///
/// Connecting to our own screen share makes every mouse move inside the remote view move the
/// real cursor, which gets dragged towards the top-left (the coordinates are off by the window
/// position), so this is checked before connecting.
/// The test is "can a socket be bound to that address"; only local addresses can be bound.
/// Name resolution can block, so this runs off the main thread (async).
#[tauri::command]
pub async fn rdp_is_self(host: String, port: Option<u16>) -> bool {
    is_local_host(&host, port.unwrap_or(3389))
}

fn is_local_host(host: &str, port: u16) -> bool {
    use std::net::{ToSocketAddrs, UdpSocket};
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs.into_iter().any(|addr| UdpSocket::bind((addr.ip(), 0)).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_own_addresses() {
        assert!(is_local_host("127.0.0.1", 3389));
        assert!(is_local_host("localhost", 3389));
        // An address reserved for documentation (TEST-NET-1) is not ours
        assert!(!is_local_host("192.0.2.1", 3389));
        assert!(!is_local_host("", 3389));
    }
}

/// The displayed RDP session changed (None means something other than RDP is shown).
/// For an RDP session, announce the local clipboard text to that session.
/// Reading the clipboard can block, so this runs off the main thread (async).
#[tauri::command]
pub async fn rdp_set_active(state: tauri::State<'_, RdpState>, id: Option<u32>) -> Result<(), String> {
    clipboard::set_active(id);
    let Some(id) = id else { return Ok(()) };
    let text = clipboard::local_text();
    if let Some(tx) = state.sessions.lock().unwrap().get(&id) {
        let _ = tx.send(Command::ClipboardLocal(text));
    }
    Ok(())
}

/// Ask the session to resend its whole screen. Called when a session is brought back to the
/// front: WebKit may drop the contents of a large hidden canvas, which would otherwise stay
/// black until the remote happens to repaint every pixel.
#[tauri::command]
pub fn rdp_refresh(state: tauri::State<'_, RdpState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let tx = sessions.get(&id).ok_or("session not found")?;
    tx.send(Command::Refresh).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rdp_close(state: tauri::State<'_, RdpState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(tx) = sessions.get(&id) {
        let _ = tx.send(Command::Close);
    }
    Ok(())
}
