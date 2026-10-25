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
/// How long a frame may stay unacknowledged by the frontend before the gate opens anyway
/// (the frontend is hidden, its message was dropped, or it is hopelessly behind).
const FRAME_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// End-to-end back-pressure for one session: at most one frame is in flight between the
/// backend and the frontend's canvas. `arm` is called when a frame is queued, `done` when
/// the frontend reports it painted (`rdp_frame_done`, after its next animation frame), and
/// `is_open` tells `flush` whether it may send. A late or unknown acknowledgement is
/// ignored (sequence numbers), and a frame that is never acknowledged stops blocking after
/// `FRAME_ACK_TIMEOUT`, so a hidden window costs one frame per timeout instead of a stall.
#[derive(Default)]
pub struct FrameGate {
    in_flight: Mutex<Option<(u32, Instant)>>,
}

impl FrameGate {
    fn arm(&self, seq: u32, now: Instant) {
        *self.in_flight.lock().unwrap() = Some((seq, now));
    }

    /// The frontend painted frame `seq`. Returns false when it was not the frame in flight.
    pub fn done(&self, seq: u32) -> bool {
        let mut slot = self.in_flight.lock().unwrap();
        match *slot {
            Some((current, _)) if current == seq => {
                *slot = None;
                true
            }
            _ => false,
        }
    }

    /// Whether a new frame may be sent at `now`. Clears a timed-out frame (and says so).
    fn is_open(&self, now: Instant) -> (bool, Option<u32>) {
        let mut slot = self.in_flight.lock().unwrap();
        match *slot {
            None => (true, None),
            Some((seq, since)) if now.duration_since(since) >= FRAME_ACK_TIMEOUT => {
                *slot = None;
                (true, Some(seq))
            }
            Some(_) => (false, None),
        }
    }
}
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
    /// The health of the connection, shown over the screen (see [`LinkState`]).
    Link { link: LinkState },
}

/// What the frontend shows about the connection while the session stays open.
#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LinkState {
    /// Back to normal: the overlay goes away.
    Ok,
    /// Data sent to the remote has gone unacknowledged for this long (the kernel is
    /// retransmitting); the session is kept, and either recovers or is lost.
    Stalled { seconds: u64 },
    /// The connection was lost; attempt `attempt` of `attempts` is about to start.
    Reconnecting { attempt: u32, attempts: u32 },
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
/// `screen width u32, screen height u32, rect count u32, frame sequence u32, send time f64 (UNIX milliseconds)`
/// followed, per rectangle, by `x, y, w, h (u32 each)` and `w*h*4` bytes of RGBA pixels.
/// The frontend answers every frame with `rdp_frame_done(id, sequence)` once painted.
pub struct FrameSink {
    id: u32,
    events: Channel<RdpEvent>,
    dirty: Vec<Rect>,
    last_sent: Instant,
    /// One frame in flight at a time, until the frontend has painted it
    gate: Arc<FrameGate>,
    seq: u32,
    frames: Sender<Vec<u8>>,
}

impl FrameSink {
    fn new(id: u32, events: Channel<RdpEvent>, frames: Channel<InvokeResponseBody>, gate: Arc<FrameGate>) -> Self {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
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
            }
        });
        Self {
            id,
            events,
            dirty: Vec::new(),
            last_sent: Instant::now(),
            gate,
            seq: 0,
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

    /// The connection stalled, is being reconnected, or is fine again.
    pub fn link(&self, link: LinkState) {
        let _ = self.events.send(RdpEvent::Link { link });
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
        if self.dirty.is_empty() || (!force && self.last_sent.elapsed() < FRAME_INTERVAL) {
            return Ok(());
        }
        let t0 = Instant::now();
        let (open, timed_out) = self.gate.is_open(t0);
        if let Some(seq) = timed_out {
            tracing::debug!(target: "iruka_perf", id = self.id, seq, "frame not acknowledged in time; sending on");
        }
        if !open {
            return Ok(());
        }
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
        self.seq = self.seq.wrapping_add(1);
        for v in [fb.width, fb.height, rects.len() as u32, self.seq] {
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
            seq = self.seq,
            rects = rects.len(),
            kb = msg.len() / 1024,
            copy_ms = t0.elapsed().as_secs_f64() * 1000.0,
            "frame queued"
        );
        self.gate.arm(self.seq, Instant::now());
        if self.frames.send(msg).is_err() {
            self.gate.done(self.seq);
        }
        self.last_sent = Instant::now();
        Ok(())
    }
}

/// A running session as the commands see it: its command channel and its frame gate.
struct SessionEntry {
    commands: Sender<Command>,
    gate: Arc<FrameGate>,
}

#[derive(Default)]
pub struct RdpState {
    sessions: Arc<Mutex<HashMap<u32, SessionEntry>>>,
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
    let gate = Arc::new(FrameGate::default());
    state.sessions.lock().unwrap().insert(id, SessionEntry { commands: tx, gate: gate.clone() });

    memory::set_session_size(id, params.width.into(), params.height.into());
    let sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let mut sink = FrameSink::new(id, on_event.clone(), on_frame, gate);
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
    let tx = &sessions.get(&id).ok_or("session not found")?.commands;
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
    // Windows resolves an empty name to the local machine's own addresses
    if host.trim().is_empty() {
        return false;
    }
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs.into_iter().any(|addr| UdpSocket::bind((addr.ip(), 0)).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_gate_allows_one_frame_in_flight() {
        let gate = FrameGate::default();
        let t0 = Instant::now();
        assert_eq!(gate.is_open(t0), (true, None));
        gate.arm(1, t0);
        assert_eq!(gate.is_open(t0 + Duration::from_millis(100)), (false, None));
        assert!(!gate.done(7), "an unknown sequence is ignored");
        assert_eq!(gate.is_open(t0 + Duration::from_millis(200)), (false, None));
        assert!(gate.done(1));
        assert_eq!(gate.is_open(t0 + Duration::from_millis(300)), (true, None));
        assert!(!gate.done(1), "a second acknowledgement of the same frame is ignored");
    }

    #[test]
    fn frame_gate_opens_after_the_timeout() {
        let gate = FrameGate::default();
        let t0 = Instant::now();
        gate.arm(5, t0);
        assert_eq!(gate.is_open(t0 + FRAME_ACK_TIMEOUT - Duration::from_millis(1)), (false, None));
        assert_eq!(gate.is_open(t0 + FRAME_ACK_TIMEOUT), (true, Some(5)));
        // The late acknowledgement of the timed-out frame must not open a gate armed since.
        gate.arm(6, t0 + FRAME_ACK_TIMEOUT);
        assert!(!gate.done(5));
        assert_eq!(gate.is_open(t0 + FRAME_ACK_TIMEOUT + Duration::from_millis(1)), (false, None));
    }

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
    if let Some(entry) = state.sessions.lock().unwrap().get(&id) {
        let _ = entry.commands.send(Command::ClipboardLocal(text));
    }
    Ok(())
}

/// Ask the session to resend its whole screen. Called when a session is brought back to the
/// front: WebKit may drop the contents of a large hidden canvas, which would otherwise stay
/// black until the remote happens to repaint every pixel.
#[tauri::command]
pub fn rdp_refresh(state: tauri::State<'_, RdpState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let tx = &sessions.get(&id).ok_or("session not found")?.commands;
    tx.send(Command::Refresh).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rdp_close(state: tauri::State<'_, RdpState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(entry) = sessions.get(&id) {
        let _ = entry.commands.send(Command::Close);
    }
    Ok(())
}

/// The frontend painted frame `seq` of session `id`; the next frame may be sent. Called after
/// the frontend's next animation frame, so the rate follows what the display actually shows.
/// A late acknowledgement (after the timeout) is ignored; a closed session is not an error.
#[tauri::command]
pub fn rdp_frame_done(state: tauri::State<'_, RdpState>, id: u32, seq: u32) {
    if let Some(entry) = state.sessions.lock().unwrap().get(&id) {
        entry.gate.done(seq);
    }
}
