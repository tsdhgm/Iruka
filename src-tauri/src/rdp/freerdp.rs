//! FreeRDP 3 backend (via native/freerdp_bridge.c).
//!
//! Supports RDPGFX (Progressive / RemoteFX / H.264), so besides Windows it can also
//! connect to GNOME Remote Desktop screen sharing.

use std::{
    ffi::{c_char, c_int, CStr, CString},
    sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError},
    time::{Duration, Instant},
};

use anyhow::{bail, Context as _};

use super::{
    Command, CursorImage, FrameSink, FrameView, LinkState, RdpBackend, RdpConnectParams, RdpInput, Rect,
    MAX_DIRTY_RECTS,
};

/// How long the kernel keeps retransmitting unacknowledged data (and unanswered keep-alive
/// probes) before it gives the connection up: FreeRDP's `/timeout`, TCP_USER_TIMEOUT. FreeRDP's
/// own default of 9 s drops a session over Wi-Fi at the first longer hiccup (KNOWN_ISSUES.md).
const TCP_ACK_TIMEOUT_MS: u32 = 60_000;
/// A stall this long is shown over the screen (updated every second until it ends).
const STALL_REPORT_AFTER: Duration = Duration::from_secs(9);
/// How often the TCP state is read.
const STALL_CHECK_INTERVAL: Duration = Duration::from_secs(1);
/// Reconnect attempts after the transport failed, and the pause between two attempts.
const RECONNECT_ATTEMPTS: u32 = 10;
const RECONNECT_INTERVAL: Duration = Duration::from_secs(5);

/// Maximum time to wait for events. The input queue and pending frames are also checked at this interval.
const POLL_TIMEOUT_MS: u32 = 15;

#[repr(C)]
struct RdpContext {
    _private: [u8; 0],
}

extern "C" {
    fn iruka_rdp_new(argc: c_int, argv: *const *const c_char) -> *mut RdpContext;
    fn iruka_rdp_connect(ctx: *mut RdpContext) -> c_int;
    fn iruka_rdp_reconnect(ctx: *mut RdpContext) -> c_int;
    fn iruka_rdp_error_is_retryable(ctx: *mut RdpContext) -> c_int;
    fn iruka_rdp_tcp_stalled(ctx: *mut RdpContext) -> c_int;
    fn iruka_rdp_poll(ctx: *mut RdpContext, timeout_ms: u32) -> c_int;
    fn iruka_rdp_framebuffer(ctx: *mut RdpContext, width: *mut u32, height: *mut u32, stride: *mut u32) -> *const u8;
    fn iruka_rdp_take_dirty(ctx: *mut RdpContext, out: *mut u32, max: c_int) -> c_int;
    fn iruka_rdp_send_mouse(ctx: *mut RdpContext, flags: u16, x: u16, y: u16);
    fn iruka_rdp_send_extended_mouse(ctx: *mut RdpContext, flags: u16, x: u16, y: u16);
    fn iruka_rdp_send_key(ctx: *mut RdpContext, scancode: u16, down: c_int);
    fn iruka_rdp_set_local_text(ctx: *mut RdpContext, text: *const c_char);
    fn iruka_rdp_take_remote_text(ctx: *mut RdpContext) -> *mut c_char;
    fn iruka_rdp_free_text(text: *mut c_char);
    fn iruka_rdp_take_cursor_image(
        ctx: *mut RdpContext,
        id: *mut u32,
        width: *mut u32,
        height: *mut u32,
        hot_x: *mut u32,
        hot_y: *mut u32,
    ) -> *mut u8;
    fn iruka_rdp_free_cursor_image(rgba: *mut u8);
    fn iruka_rdp_take_cursor(ctx: *mut RdpContext, id: *mut u32) -> c_int;
    fn iruka_rdp_last_error(ctx: *mut RdpContext) -> *const c_char;
    fn iruka_rdp_disconnect(ctx: *mut RdpContext);
    fn iruka_rdp_free(ctx: *mut RdpContext);
}

// freerdp/input.h
const PTR_FLAGS_HWHEEL: u16 = 0x0400;
const PTR_FLAGS_WHEEL: u16 = 0x0200;
const PTR_FLAGS_MOVE: u16 = 0x0800;
const PTR_FLAGS_DOWN: u16 = 0x8000;
const PTR_FLAGS_BUTTON1: u16 = 0x1000; // left
const PTR_FLAGS_BUTTON2: u16 = 0x2000; // right
const PTR_FLAGS_BUTTON3: u16 = 0x4000; // middle
const PTR_XFLAGS_DOWN: u16 = 0x8000;
const PTR_XFLAGS_BUTTON1: u16 = 0x0001;
const PTR_XFLAGS_BUTTON2: u16 = 0x0002;

// Cursor ids reserved by the C bridge (CURSOR_DEFAULT / CURSOR_HIDDEN in freerdp_bridge.c)
const CURSOR_DEFAULT: u32 = 0;
const CURSOR_HIDDEN: u32 = 1;

pub struct FreeRdp;

impl RdpBackend for FreeRdp {
    fn name(&self) -> &'static str {
        "FreeRDP"
    }

    fn run(
        &self,
        params: &RdpConnectParams,
        commands: &Receiver<Command>,
        sink: &mut FrameSink,
    ) -> anyhow::Result<String> {
        let session = Session::new(params)?;
        session.connect()?;
        loop {
            let reason = match session.run(commands, sink)? {
                Outcome::Closed(reason) => return Ok(reason),
                Outcome::Lost(reason) => reason,
            };
            tracing::info!(host = params.host, reason, "connection lost; reconnecting");
            if !session.reconnect(commands, sink)? {
                return Ok("Disconnected".into());
            }
        }
    }
}

/// How a session's event loop ended.
enum Outcome {
    /// Over for good: closed from the frontend, or ended by the server.
    Closed(String),
    /// The transport failed; a reconnect may bring the session back.
    Lost(String),
}

/// One FreeRDP session. Only used from the thread that created it.
struct Session {
    ctx: *mut RdpContext,
    connected: std::cell::Cell<bool>,
    /// Last known mouse position (button and wheel events need coordinates too)
    mouse: std::cell::Cell<(u16, u16)>,
}

impl Session {
    fn new(params: &RdpConnectParams) -> anyhow::Result<Self> {
        let (domain, username) = params.domain_and_user();
        // Configure via FreeRDP's command-line syntax (gives the same defaults as xfreerdp)
        let mut args = vec![
            "iruka".to_owned(),
            format!("/v:{}", params.host),
            format!("/port:{}", params.port()),
            format!("/u:{username}"),
            format!("/p:{}", params.password),
            format!("/size:{}x{}", params.width, params.height),
            "/bpp:32".to_owned(),
            // Graphics pipeline (required by GNOME Remote Desktop) and automatic network detection.
            // Enabling /gfx also makes FreeRDP allocate decode buffers it never uses
            // (see KNOWN_ISSUES.md; details in iruka_pre_connect in freerdp_bridge.c)
            if params.small_cache { "/gfx:small-cache" } else { "/gfx" }.to_owned(),
            "/network:auto".to_owned(),
            format!("/timeout:{TCP_ACK_TIMEOUT_MS}"),
            // Accept self-signed certificates (the equivalent of "Continue" in mstsc)
            "/cert:ignore".to_owned(),
        ];
        if !params.clipboard {
            args.push("-clipboard".to_owned());
        }
        // Audio in/out. FreeRDP picks the playback/capture backend for the OS (PulseAudio on Linux)
        if params.audio {
            args.push("/sound".to_owned());
        } else {
            args.push("/audio-mode:2".to_owned()); // do not play audio
        }
        if params.microphone {
            args.push("/microphone".to_owned());
        }
        if let Some(domain) = domain {
            args.push(format!("/d:{domain}"));
        }
        let cargs: Vec<CString> = args
            .into_iter()
            .map(CString::new)
            .collect::<Result<_, _>>()
            .context("The connection settings contain characters that cannot be used")?;
        let argv: Vec<*const c_char> = cargs.iter().map(|a| a.as_ptr()).collect();

        // SAFETY: argv points into `cargs`, which outlives the call, and FreeRDP copies the
        // arguments it keeps. The returned context (or NULL) is owned by this Session and
        // released exactly once in Drop.
        let ctx = unsafe { iruka_rdp_new(argv.len() as c_int, argv.as_ptr()) };
        if ctx.is_null() {
            bail!("Could not create the FreeRDP session (failed to parse the settings)");
        }
        Ok(Self {
            ctx,
            connected: false.into(),
            mouse: (0, 0).into(),
        })
    }

    fn last_error(&self) -> String {
        // SAFETY: ctx is the valid context owned by this Session.
        let msg = unsafe { iruka_rdp_last_error(self.ctx) };
        if msg.is_null() {
            return "Unknown error".into();
        }
        // SAFETY: msg is non-null and points to a static, NUL-terminated string owned by
        // FreeRDP; it is copied here and never freed by us.
        unsafe { CStr::from_ptr(msg) }.to_string_lossy().into_owned()
    }

    fn connect(&self) -> anyhow::Result<()> {
        // Set before the attempt: the cleanup (disconnect) is needed even if it fails
        self.connected.set(true);
        // SAFETY: ctx is the valid context owned by this Session, used only on this thread.
        if unsafe { iruka_rdp_connect(self.ctx) } == 0 {
            bail!("Connection failed: {}", self.last_error());
        }
        Ok(())
    }

    fn framebuffer(&self) -> Option<FrameView<'_>> {
        let (mut width, mut height, mut stride) = (0, 0, 0);
        // SAFETY: ctx is the valid context owned by this Session; the out-pointers refer to
        // locals that live for the duration of the call.
        let data = unsafe { iruka_rdp_framebuffer(self.ctx, &mut width, &mut height, &mut stride) };
        if data.is_null() {
            return None;
        }
        // SAFETY: the gdi primary_buffer is stride * height bytes. It is only reallocated by
        // gdi_resize, which runs inside iruka_rdp_poll on this same thread because dynamic
        // channels are synchronous (see iruka_rdp_new in freerdp_bridge.c). The returned
        // FrameView must therefore only be used until the next iruka_rdp_poll call, and only
        // from the thread that owns the session (Session is not shared across threads).
        let data = unsafe { std::slice::from_raw_parts(data, stride as usize * height as usize) };
        Some(FrameView {
            data,
            width,
            height,
            stride: stride as usize,
        })
    }

    fn run(&self, commands: &Receiver<Command>, sink: &mut FrameSink) -> anyhow::Result<Outcome> {
        let mut size = (0, 0);
        let mut refresh = false;
        let mut stall = StallWatch::default();
        loop {
            loop {
                match commands.try_recv() {
                    Ok(Command::Input(inputs)) => inputs.into_iter().for_each(|i| self.send_input(i)),
                    Ok(Command::ClipboardLocal(text)) => self.set_local_text(text.as_deref()),
                    Ok(Command::Refresh) => refresh = true,
                    Ok(Command::Close) | Err(TryRecvError::Disconnected) => {
                        // Let go of any modifier before the connection drops: the server keeps the
                        // state of our virtual keyboard, and a Ctrl left pressed here would stick to
                        // every later client of that machine (GNOME merges all keyboards' modifiers).
                        self.send_input(RdpInput::ReleaseAll);
                        return Ok(Outcome::Closed("Disconnected".into()));
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }

            // SAFETY: ctx is the valid context owned by this Session. All gdi callbacks
            // (paint, resize, dirty list) run inside this call on this thread, so no
            // FrameView from a previous iteration is alive while it runs.
            let status = unsafe { iruka_rdp_poll(self.ctx, POLL_TIMEOUT_MS) };

            if status == 1 && stall.due(Instant::now()) {
                // SAFETY: ctx is the valid context owned by this Session.
                let stalled = unsafe { iruka_rdp_tcp_stalled(self.ctx) } == 1;
                if let Some(link) = stall.observe(stalled, Instant::now()) {
                    sink.link(link);
                }
            }

            if let Some(text) = self.take_remote_text() {
                sink.clipboard_from_remote(&text);
            }
            while let Some(img) = self.take_cursor_image() {
                sink.cursor_image(img);
            }
            if let Some(id) = self.take_cursor() {
                sink.cursor(id);
            }

            if let Some(fb) = self.framebuffer() {
                if (fb.width, fb.height) != size {
                    size = (fb.width, fb.height);
                    sink.resize(fb.width, fb.height)?;
                    // The screen was rebuilt; send all of it
                    sink.damage(Rect {
                        x: 0,
                        y: 0,
                        width: fb.width,
                        height: fb.height,
                    });
                }
                let mut rects = [0u32; MAX_DIRTY_RECTS * 4];
                // SAFETY: rects holds MAX_DIRTY_RECTS * 4 u32s, so the C side writes at most
                // MAX_DIRTY_RECTS rectangles (4 u32s each) into it.
                let n = unsafe { iruka_rdp_take_dirty(self.ctx, rects.as_mut_ptr(), MAX_DIRTY_RECTS as c_int) };
                for r in rects.chunks_exact(4).take(n.max(0) as usize) {
                    sink.damage(Rect {
                        x: r[0],
                        y: r[1],
                        width: r[2],
                        height: r[3],
                    });
                }
                if refresh {
                    refresh = false;
                    sink.damage(Rect {
                        x: 0,
                        y: 0,
                        width: fb.width,
                        height: fb.height,
                    });
                    sink.flush(&fb, true)?;
                } else {
                    sink.flush(&fb, status != 1)?;
                }
            }

            match status {
                1 => {}
                0 => return Ok(Outcome::Closed("The server closed the connection".into())),
                _ => {
                    let reason = format!("Communication error: {}", self.last_error());
                    // SAFETY: ctx is the valid context owned by this Session.
                    if unsafe { iruka_rdp_error_is_retryable(self.ctx) } == 1 {
                        return Ok(Outcome::Lost(reason));
                    }
                    bail!("{reason}");
                }
            }
        }
    }

    /// Try to get the session back after the transport failed: up to `RECONNECT_ATTEMPTS`
    /// attempts, `RECONNECT_INTERVAL` apart, the frontend told about each. Returns Ok(false)
    /// when the session was closed from the frontend meanwhile; an error when the attempts
    /// are used up or the server refuses in a way that retrying cannot fix.
    fn reconnect(&self, commands: &Receiver<Command>, sink: &mut FrameSink) -> anyhow::Result<bool> {
        for attempt in 1..=RECONNECT_ATTEMPTS {
            sink.link(LinkState::Reconnecting {
                attempt,
                attempts: RECONNECT_ATTEMPTS,
            });
            if attempt > 1 && !wait_closed_or_timeout(commands, RECONNECT_INTERVAL) {
                return Ok(false);
            }
            // SAFETY: ctx is the valid context owned by this Session, used only on this thread.
            if unsafe { iruka_rdp_reconnect(self.ctx) } == 1 {
                tracing::info!(attempt, "reconnected");
                sink.link(LinkState::Ok);
                return Ok(true);
            }
            let error = self.last_error();
            tracing::info!(attempt, error, "reconnect attempt failed");
            // SAFETY: ctx is the valid context owned by this Session.
            if unsafe { iruka_rdp_error_is_retryable(self.ctx) } != 1 {
                bail!("Reconnect refused: {error}");
            }
        }
        bail!(
            "Connection lost; gave up after {RECONNECT_ATTEMPTS} reconnect attempts (last: {})",
            self.last_error()
        )
    }

    fn set_local_text(&self, text: Option<&str>) {
        // Text containing NUL cannot be passed to C, so truncate at the first NUL
        let text = text.map(|t| CString::new(t.split('\0').next().unwrap_or("")).unwrap());
        let ptr = text.as_ref().map_or(std::ptr::null(), |t| t.as_ptr());
        // SAFETY: ptr is NULL or points to the NUL-terminated `text`, which outlives the
        // call; the C side takes its own copy (_strdup).
        unsafe { iruka_rdp_set_local_text(self.ctx, ptr) };
    }

    fn take_remote_text(&self) -> Option<String> {
        // SAFETY: ctx is the valid context owned by this Session. The C side hands over
        // ownership of a heap-allocated, NUL-terminated UTF-8 string (or NULL).
        let ptr = unsafe { iruka_rdp_take_remote_text(self.ctx) };
        if ptr.is_null() {
            return None;
        }
        // SAFETY: ptr is non-null and NUL-terminated (see above) and stays valid until it
        // is freed below.
        let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        // SAFETY: ptr came from iruka_rdp_take_remote_text and is freed exactly once here;
        // `text` is an owned copy.
        unsafe { iruka_rdp_free_text(ptr) };
        Some(text)
    }

    fn take_cursor_image(&self) -> Option<CursorImage> {
        let (mut id, mut width, mut height, mut hot_x, mut hot_y) = (0, 0, 0, 0, 0);
        // SAFETY: ctx is the valid context owned by this Session; the out-pointers refer to
        // locals that live for the duration of the call. The C side hands over ownership of
        // a heap buffer of width * height * 4 bytes (or NULL).
        let ptr = unsafe {
            iruka_rdp_take_cursor_image(self.ctx, &mut id, &mut width, &mut height, &mut hot_x, &mut hot_y)
        };
        if ptr.is_null() {
            return None;
        }
        let len = width as usize * height as usize * 4;
        // SAFETY: ptr is non-null and points to `len` initialised bytes (see above); they are
        // copied out before the buffer is freed, exactly once, below.
        let rgba = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        // SAFETY: ptr came from iruka_rdp_take_cursor_image and is freed exactly once here;
        // `rgba` is an owned copy.
        unsafe { iruka_rdp_free_cursor_image(ptr) };
        Some(CursorImage {
            id,
            width,
            height,
            hot_x,
            hot_y,
            rgba,
        })
    }

    /// The cursor the server selected since the last poll, if any (None inside = hidden).
    fn take_cursor(&self) -> Option<Option<u32>> {
        let mut id = 0;
        // SAFETY: ctx is the valid context owned by this Session; `id` lives for the call.
        if unsafe { iruka_rdp_take_cursor(self.ctx, &mut id) } == 0 {
            return None;
        }
        Some(match id {
            CURSOR_HIDDEN => None,
            CURSOR_DEFAULT => Some(0),
            other => Some(other),
        })
    }

    fn send_input(&self, input: RdpInput) {
        let ctx = self.ctx;
        let (mx, my) = self.mouse.get();
        // SAFETY: ctx is the valid context owned by this Session, used only on this thread;
        // the send functions take plain integers.
        unsafe {
            match input {
                RdpInput::MouseMove { x, y } => {
                    self.mouse.set((x, y));
                    iruka_rdp_send_mouse(ctx, PTR_FLAGS_MOVE, x, y);
                }
                RdpInput::MouseButton { button, down } => {
                    let flags = match button {
                        0 => PTR_FLAGS_BUTTON1,
                        1 => PTR_FLAGS_BUTTON3,
                        2 => PTR_FLAGS_BUTTON2,
                        3 | 4 => {
                            let x = if button == 3 { PTR_XFLAGS_BUTTON1 } else { PTR_XFLAGS_BUTTON2 };
                            let down = if down { PTR_XFLAGS_DOWN } else { 0 };
                            iruka_rdp_send_extended_mouse(ctx, x | down, mx, my);
                            return;
                        }
                        _ => return,
                    };
                    let down = if down { PTR_FLAGS_DOWN } else { 0 };
                    iruka_rdp_send_mouse(ctx, flags | down, mx, my);
                }
                RdpInput::Wheel { vertical, units } => {
                    // The rotation amount is a 9-bit two's complement value (0x100 is the sign bit)
                    let rotation = (units.clamp(-255, 255) as u16) & 0x01ff;
                    let kind = if vertical { PTR_FLAGS_WHEEL } else { PTR_FLAGS_HWHEEL };
                    iruka_rdp_send_mouse(ctx, kind | rotation, mx, my);
                }
                RdpInput::Key { scancode, down } => {
                    // Both edges are logged so a stuck modifier can be traced to a missing release.
                    tracing::debug!(target: "iruka_perf", scancode, down, "key sent to FreeRDP");
                    iruka_rdp_send_key(ctx, scancode, down.into())
                }
                // FreeRDP does not track key state, so on focus loss only the modifier keys are released
                RdpInput::ReleaseAll => {
                    for sc in [0x2a, 0x36, 0x1d, 0xe01d, 0x38, 0xe038, 0xe05b, 0xe05c] {
                        iruka_rdp_send_key(ctx, sc, 0);
                    }
                }
            }
        }
    }
}

/// Pause between reconnect attempts, still listening to the frontend. False when the session
/// was closed (or its command channel dropped) during the pause; input is not deliverable and
/// is discarded.
fn wait_closed_or_timeout(commands: &Receiver<Command>, pause: Duration) -> bool {
    let deadline = Instant::now() + pause;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match commands.recv_timeout(left) {
            Ok(Command::Close) | Err(RecvTimeoutError::Disconnected) => return false,
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => return true,
        }
    }
}

/// Watches the TCP state once a second and decides what to tell the frontend: a stall that has
/// lasted `STALL_REPORT_AFTER` (reported every second with its length), and its end.
#[derive(Default)]
struct StallWatch {
    last_check: Option<Instant>,
    since: Option<Instant>,
    reported: bool,
}

impl StallWatch {
    fn due(&mut self, now: Instant) -> bool {
        if self.last_check.is_some_and(|t| now.duration_since(t) < STALL_CHECK_INTERVAL) {
            return false;
        }
        self.last_check = Some(now);
        true
    }

    fn observe(&mut self, stalled: bool, now: Instant) -> Option<LinkState> {
        if !stalled {
            self.since = None;
            return std::mem::take(&mut self.reported).then_some(LinkState::Ok);
        }
        let length = now.duration_since(*self.since.get_or_insert(now));
        if length < STALL_REPORT_AFTER {
            return None;
        }
        self.reported = true;
        Some(LinkState::Stalled {
            seconds: length.as_secs(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn stall_watch_reports_after_the_threshold_and_once_when_over() {
        let t0 = Instant::now();
        let mut w = StallWatch::default();
        assert!(w.due(t0));
        assert!(!w.due(t0 + Duration::from_millis(500)), "checked once a second");
        assert!(w.due(t0 + secs(1)));
        assert!(w.observe(false, t0).is_none(), "nothing to say while the link is fine");
        assert!(w.observe(true, t0 + secs(1)).is_none(), "a short stall is not shown");
        assert!(w.observe(true, t0 + secs(5)).is_none());
        assert!(matches!(
            w.observe(true, t0 + secs(10)),
            Some(LinkState::Stalled { seconds: 9 })
        ));
        assert!(matches!(
            w.observe(true, t0 + secs(11)),
            Some(LinkState::Stalled { seconds: 10 })
        ));
        assert!(matches!(w.observe(false, t0 + secs(12)), Some(LinkState::Ok)));
        assert!(w.observe(false, t0 + secs(13)).is_none(), "the end is reported once");
        assert!(w.observe(true, t0 + secs(14)).is_none(), "a new stall starts from zero");
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: ctx was returned by iruka_rdp_new (non-null) and is freed exactly once
        // here; disconnect is only called if a connect was attempted (see Session::connect).
        unsafe {
            if self.connected.get() {
                iruka_rdp_disconnect(self.ctx);
            }
            iruka_rdp_free(self.ctx);
        }
    }
}
