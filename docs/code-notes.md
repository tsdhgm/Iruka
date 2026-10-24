*日本語版: [code-notes_JA.md](code-notes_JA.md)*

# Design notes and known weak spots

Notes for people reading or changing the code. They describe how the pieces fit together, which invariants matter at the Rust / C boundary, and where the code is known to be rough. Facts and numbers here were checked against the source on 2026-10-13; when the code and this document disagree, the code wins.

## 1. Architecture overview

Iruka is a Tauri 2 application: a React / TypeScript frontend in a WebView, and a Rust backend (`src-tauri`) that owns every connection. Nothing network-related runs in the WebView.

```
WebView (React)                      Rust (src-tauri)                        Native / network
----------------------------------   -------------------------------------   -------------------------
App.tsx, src/components, hostKey.ts  lib.rs: Tauri commands, log filter
                                     pty.rs: consoles (portable-pty)  <----> local shell
  <canvas> per RDP session  <-----   rdp/mod.rs: RdpState, FrameSink
  Channel<ArrayBuffer> (frames)        |-- rdp/freerdp.rs  --FFI-->  native/freerdp_bridge.c --> libfreerdp3
  Channel<RdpEvent>   (resize/closed)  '-- rdp/ironrdp.rs  ---------> IronRDP crates (rustls)  --> server
                                     clipboard.rs: arboard + active-session id
                                     memory.rs: usage sampler + estimate model
```

### Tauri commands

`lib.rs` registers the commands the frontend calls with `invoke`:

- consoles: `spawn_session`, `write_session`, `resize_session`, `kill_session` (`pty.rs`)
- RDP: `rdp_connect`, `rdp_input`, `rdp_close`, `rdp_set_active`, `rdp_is_self`, `rdp_perf_log` (`rdp/mod.rs`)
- memory: `rdp_memory_check`, `rdp_memory_budget` (`memory.rs`)
- credentials: `credential_set`, `credential_get`, `credential_delete` (`credentials.rs`)

Console and RDP sessions share one id space: `NEXT_SESSION_ID` (an `AtomicU32` in `lib.rs`), so the frontend can keep them in a single list.

### The `RdpBackend` trait

`rdp/mod.rs` holds everything that is common to RDP sessions (session registry, frame delivery, input types) and leaves the protocol to a backend:

```rust
pub trait RdpBackend: Sync {
    fn name(&self) -> &'static str;
    fn run(&self, params: &RdpConnectParams, commands: &Receiver<Command>, sink: &mut FrameSink)
        -> anyhow::Result<String>;
}
```

`rdp_connect` picks a backend (`select_backend`: Auto prefers FreeRDP when the `freerdp` feature is compiled in), allocates an id, stores a `Sender<Command>` in `RdpState`, and spawns **one thread per session** that calls `run`. `run` must poll `commands` regularly (`Input`, `ClipboardLocal`, `Close`) and return when the session ends; the thread then removes the session from the registry and sends `RdpEvent::Closed { reason, error, backend }`. Both features (`freerdp`, `ironrdp`) are on by default in `Cargo.toml`; `build.rs` compiles `native/freerdp_bridge.c` with `cc` against `freerdp-client3` from pkg-config.

**FreeRDP backend** (`rdp/freerdp.rs` + `native/freerdp_bridge.c`): the Rust side builds a FreeRDP command line (`/v: /port: /u: /p: /size: /bpp:32 /gfx[:small-cache] /network:auto /cert:ignore`, plus `-clipboard`, `/sound` or `/audio-mode:2`, `/microphone`, `/d:`) and hands it to `iruka_rdp_new`, so defaults match `xfreerdp`. The C bridge is modelled on FreeRDP's headless sample (`client/Sample/tf_freerdp.c`): it initialises `gdi` with `PIXEL_FORMAT_RGBX32`, hooks `BeginPaint` / `EndPaint` / `DesktopResize`, and records the invalid regions `EndPaint` reports into a small dirty-rect list (up to 128, collapsed into one bounding rect beyond that). RDPGFX (Progressive / RemoteFX / H.264) is enabled with `/gfx`; this is what makes GNOME Remote Desktop work, since it refuses clients without the graphics pipeline. The Rust loop is: drain `commands` → `iruka_rdp_poll` (waits up to 15 ms on FreeRDP's event handles) → pick up remote clipboard text → read the framebuffer and dirty rects → `sink.flush`.

**IronRDP backend** (`rdp/ironrdp.rs`): pure Rust, using `ironrdp-blocking` over a `rustls` TLS stream and CredSSP. It decodes into a `DecodedImage` (RGBA) and feeds `GraphicsUpdate` rectangles into the sink. It also handles the Deactivation-Reactivation sequence (resolution change after logon). See weak spot (e) for its limits.

### `FrameSink` and the binary frame format

`FrameSink` is the backend-facing side of frame delivery:

- `damage(rect)` collects dirty rectangles. Beyond `MAX_DIRTY_RECTS` (128) they are collapsed into one bounding rect.
- `flush(fb, force)` runs at most every `FRAME_INTERVAL` (33 ms, about 30 fps) unless `force` is set. It merges overlapping or touching rectangles (`merge_rects`), clips them to the framebuffer, copies the pixels of each rect out of the `FrameView` into one `Vec<u8>` (forcing alpha to 0xff), and queues it.
- A **separate send thread** per session (spawned in `FrameSink::new`) takes queued messages from an `mpsc` channel and pushes each to the WebView with `Channel<InvokeResponseBody>::send(InvokeResponseBody::Raw(..))`. The session thread therefore never blocks on the WebView, so input latency does not depend on rendering.
- **Back-pressure**: a shared `busy: Arc<AtomicBool>` is set when a message is queued and cleared by the send thread after `send` returns. While it is set, `flush` does nothing and the dirty rects keep accumulating, so the next flush sends one merged, up-to-date frame instead of a backlog.
- `resize(width, height)` clears the dirty list, records the size for the memory model, and sends `RdpEvent::Resize`; the frontend recreates the canvas at the new size and the backend then damages the whole screen.

The frame message is little-endian binary:

| Offset | Field |
|---|---|
| 0 | framebuffer width, `u32` |
| 4 | framebuffer height, `u32` |
| 8 | rectangle count, `u32` |
| 12 | reserved, `u32` (0) |
| 16 | `sent_at`, `f64`, UNIX time in milliseconds (for lag measurement) |
| 24 | per rectangle: `x, y, w, h` as four `u32`, followed by `w*h*4` bytes of RGBA |

The frontend (`src/rdpSession.ts`) reads it with a `DataView`, drops a message whose framebuffer size does not match the canvas (a frame that crossed a resize), and paints each rect with `putImageData`. Thumbnails are redrawn from the session canvas (`drawCanvasToCanvas` in `src/rdp.ts`).

### The canvas is the only frontend copy of the screen

The WebView keeps the remote screen only in the session's `<canvas>`; the backend sends changed rectangles, never a full frame on its own. While a session is hidden (grid view, another session on top) the canvas is `display: none`, and WebKitGTK may drop the contents of a large hidden canvas. When it is shown again it is black, and it stays black until the remote happens to repaint every pixel (seen 2026-10-15 with 4K sessions after toggling the grid view with the right Alt key; a second client connecting to the same GNOME Remote Desktop target made the server resend the whole screen, which "fixed" it). Therefore `showSession` calls the `rdp_refresh` command whenever an RDP session is brought to the front: the backend marks the whole framebuffer dirty and sends one full frame from its own copy (FreeRDP's gdi buffer or IronRDP's `DecodedImage`), without involving the server.

### Input

The frontend converts `KeyboardEvent.code` to PC/AT Set 1 scancodes with the `SCANCODES` table in `src/rdp.ts` (extended keys are `0xE0xx`), so the layout is decided by the remote. Mouse coordinates are mapped to remote pixels by `toRemoteCoords`. Events are batched into `rdp_input` calls as `RdpInput` values (`MouseMove`, `MouseButton`, `Wheel`, `Key`, `ReleaseAll`); `ReleaseAll` is sent on blur to release modifier keys, since FreeRDP does not track key state.

### Frontend layout

`App.tsx` holds session state; forms, grid view, toolbar, modals and the host-key tracker live in `src/components` and `src/hostKey.ts`, and the per-session wiring (frame decoding for RDP, xterm.js for consoles) is in `src/rdpSession.ts` and `src/ptySession.ts`. The host-key tracker implements the "right Alt alone toggles the grid, right Alt + key is a normal Alt" rule: it holds the key-down until it knows whether another key follows.

### Credentials and worksets

Saved connections (`src/profiles.ts`, `localStorage` `iruka.profiles`) carry everything but the password. With `savePassword` on, the password is in the OS credential store through the `keyring` crate (`credentials.rs`: Secret Service via zbus on Linux, Credential Manager on Windows, Keychain on macOS; service `dev.tosihide.iruka`, user = the profile id, so renaming a connection keeps its password and nothing in the store names a host). The three commands run the store calls on a blocking thread (`tauri::async_runtime::spawn_blocking`); the frontend (`src/credentials.ts`) treats a missing or unavailable store as "no password" and falls back to the form. `upsertProfile` returns the entry as stored, because connecting twice to the same host reuses the existing id and the credential must follow that id.

A workset (`src/worksets.ts`) is a list of profile ids in sidebar order plus the view and grid columns; each `SessionInfo` carries the `profileId` it came from so the current set can be captured. "Last open sessions" is written one second after any change while at least one profile-backed session is open. `restoreWorkset` in `App.tsx` asks `rdp_memory_budget` for the estimates of all RDP items at once, adds them up in order and drops the ones that do not fit, then starts the sessions sequentially: an RDP session is awaited until its first `running` / `exited` status (`pendingRef`, resolved from `updateSession`) or 20 s, so that 20 FreeRDP connects do not initialise at the same time. The report modal lists what was skipped and why.

### PTY sessions (consoles)

`pty.rs` uses `portable-pty`. `spawn_session` starts the requested program (or `$SHELL`, falling back to `bash`) with `TERM=xterm-256color` in the home directory, and spawns two threads: one streams output to the WebView as base64 over a `Channel<PtyEvent>`, the other waits for the child and sends `Exit`. The frontend renders with xterm.js and derives the "running / idle / exited" tile status from output timing.

### Memory model

`memory.rs` estimates how much memory one more RDP session will need, so the UI can warn before connecting. One session is modelled as `BASE_SESSION_BYTES + BASE_BYTES_PER_PIXEL × pixels`, multiplied by a learned scale. A background thread samples the memory of the whole process tree (Iruka plus the WebView and other children, threads excluded) every 3 s with `sysinfo`:

- With no RDP sessions open (after a 15 s warm-up), the lowest reading becomes the **baseline** for this run.
- With sessions open, `scale = (used − baseline) / base_estimate(sessions, pixels)` is appended to a list of observations (at most 1200, about an hour).
- The estimate uses the **95th percentile** of the observations once there are at least 20, times a **1.2 safety factor**. The observations are saved to `memory-model.json` in the app data directory every 60 s and loaded at start-up.

`rdp_memory_check` returns available memory (from the OS) and the estimate; in debug builds `IRUKA_FAKE_AVAILABLE_MB` fakes the available figure for testing the dialog. `lib.rs` also sets glibc's `M_MMAP_THRESHOLD` to 256 KB on Linux so large frame buffers go back to the OS when freed instead of lingering in per-thread arenas.

**Measured 2026-10-23** (Linux client, debug build, Ubuntu 26.04, FreeRDP 3.32.1, WebKitGTK 2.52.6; `used_mb` is the whole process tree; the target was a Windows 11 PC at 3840×2160):

| State | `used_mb` |
|---|---|
| Idle after start (baseline) | 482–512 |
| One 3840×2160 session, the first of the run | 1009–1115 |
| After closing it | 665–711 |
| Two 3840×2160 sessions (85 min) | 1692–1940 |
| Back to one session (operated for 15 min) | 1444–1592 |
| All sessions closed, 6 min later | 1079–1117, steady |

Windows client (docs/windows-client-log.md): 393 idle, about 1,580–1,630 with one 3840×2160 session, 1,010 after closing a 1920×1080 session. So one 4K session costs about 550 MB on Linux against about 1.2 GB on Windows. Both clients keep memory after a session closes, and on Linux the kept amount grows with each open/close cycle (after-close readings in one run: 666 → 684 → 791 → 1080).

Where it sits (`/proc/<pid>/smaps` of the main process after everything was closed): 574 MB anonymous memory in the main process, 114 MB in the WebKit web process. Seven mappings of the main process were 64 MB glibc malloc arena heaps, each almost fully resident (about 440 MB together), plus two part-filled ones. That is most likely memory the session threads freed but glibc kept: an arena only shrinks from its top, and these are fragmented with allocations below `M_MMAP_THRESHOLD` (FreeRDP codec and cache state, channel buffers). Things to try: `malloc_trim(0)` when a session ends, or `M_ARENA_MAX` to cap the number of arenas; whether part of it is a real leak (FreeRDP context or codec state not freed) is not established and would need a heaptrack run. Tracked in TODO.md.

### Clipboard

Text only, and only for the session on screen. `clipboard.rs` keeps one `arboard::Clipboard` for the life of the process (on X11 the owner object must stay alive for other applications to read the data) and an `ACTIVE` session id. `rdp_set_active` (called by the frontend on focus changes) stores the id and pushes the local text to that session as `Command::ClipboardLocal`; `FrameSink::clipboard_from_remote` only writes to the local clipboard when the copying session is the active one. Line endings are normalised to CRLF towards the remote and to LF on non-Windows locally. In the C bridge, cliprdr is wired by `iruka_on_channel_connected`: the server's format list triggers a request for `CF_UNICODETEXT`, the response is stored in `remote_text` for the Rust loop to collect, and a server data request is answered from `local_text`.

### Cursor shape

In RDP the cursor is not part of the screen image; the server sends each shape as a pointer update and selects one (also from its cache) as the user moves. The C bridge registers a pointer class with `graphics_register_pointer` (`iruka_pointer_*`): `New` converts the shape to RGBA with `freerdp_image_copy_from_pointer_data` and queues it with a fresh id (`cursor_images`), `Set` / `SetNull` / `SetDefault` record the selection (`cursor_id`, ids 0 and 1 are the local default and hidden). After every poll the Rust loop drains the queue into `RdpEvent::CursorImage` (base64 RGBA, hotspot) and the selection into `RdpEvent::Cursor`. The frontend (`rdpSession.ts`) keeps up to `MAX_CURSOR_SHAPES` shapes as PNG data URLs and sets the canvas's CSS `cursor`; `remoteCursorStyle` in `rdp.ts` scales the image by the device pixel ratio, because the canvas shows remote pixels 1:1 physically while a CSS cursor image is in CSS pixels. WebKit ignores cursor images larger than 128×128 CSS pixels (the bridge drops anything above 256×256); Windows gets there only with a very large "Mouse pointer size" setting, and the local arrow is shown instead. IronRDP sends no cursor events, so the default arrow stays.

## 2. Threading and the FFI boundary

Threads involved in one FreeRDP session:

| Thread | What runs on it |
|---|---|
| session thread (spawned by `rdp_connect`) | `RdpBackend::run`: the poll loop, all `iruka_rdp_*` calls, `FrameSink::flush` (pixel copy), the pointer callbacks (`iruka_pointer_*`, delivered on the main channel inside `iruka_rdp_poll`) |
| send thread (spawned by `FrameSink::new`) | `Channel::send` to the WebView |
| FreeRDP static-channel threads | cliprdr callbacks (`clip_*` in the C bridge) |
| memory sampler (`memory::start`) | `sysinfo` refresh, model update, file save |

**Dynamic channels are forced synchronous.** `iruka_rdp_new` sets `FreeRDP_SynchronousDynamicChannels` to `TRUE`. By default FreeRDP's drdynvc has its own thread, and RDPGFX drawing (`gdi_OutputUpdate` → `EndPaint`) as well as the server's ResetGraphics (`gdi_ResetGraphics` → `DesktopResize` → `gdi_resize`) run on it. `gdi_resize` frees and reallocates `gdi->primary_buffer`. On 2026-10-13, right after a second 4K session connected, a ResetGraphics on drdynvc's thread reallocated the buffer while the Rust loop was copying a full 4K frame (about 150 ms) on the session thread, and `memcpy` read freed memory and segfaulted. The dirty list raced the same way. With synchronous dynamic channels, everything that touches `gdi` runs on the thread that calls `iruka_rdp_poll`.

The invariants that follow from this:

- All `iruka_rdp_*` functions are called from the session thread only. The `Session` struct in `freerdp.rs` is deliberately not `Send`.
- `FrameView` borrows `gdi->primary_buffer` through a raw pointer (`iruka_rdp_framebuffer`). The slice is valid **only until the next `iruka_rdp_poll`**; never keep it across a poll and never hand it to another thread. `flush` copies what it needs before returning.
- The dirty list in `IrukaContext` is read and reset by `iruka_rdp_take_dirty` on the same thread.
- cliprdr is a static virtual channel and its callbacks **do** run on a FreeRDP channel thread. Everything they share with the session thread (`cliprdr`, `clip_ready`, `local_text`, `remote_text`) is guarded by `clip_lock` (a `CRITICAL_SECTION`), and the hand-off is by ownership transfer: `iruka_rdp_take_remote_text` moves the pointer out under the lock and the Rust side frees it with `iruka_rdp_free_text`.
- Strings crossing into C are `CString`s; text containing NUL is truncated at the first NUL (`set_local_text`).

The IronRDP backend has no FFI; its loop alternates between draining `commands` and `read_pdu` with a 15 ms socket read timeout on the session thread.

## 3. Known weak spots

Written for contributors, not as a sales pitch. These are things that work but are rough, or that need changing before a wider release.

**(a) Global and static state scattered across modules.** The clipboard's active-session id is an `AtomicU32` in `clipboard.rs`; the memory model is a `LazyLock<Mutex<Model>>` plus a `SESSION_SIZES` map in `memory.rs`, persisted as JSON; the session registry lives in `RdpState` (managed by Tauri); the session id counter is a static in `lib.rs`. Each piece is small and works, but the flow of "which session is active and what does it own" is spread over four files and is hard to follow. A single session-manager type would be the obvious refactor.

**(b) The memory estimate constants are empirical.** `BASE_SESSION_BYTES` (150 MB fixed per session) and `BASE_BYTES_PER_PIXEL` (66 B/px) come from measurements on 2026-10-09 of Iruka as a whole: FreeRDP at 1080p about 290 MB, at 4K about 610–780 MB with `/gfx:small-cache`; IronRDP at 4K about 325 MB. Only the overall scale is learned (95th percentile of observations, times 1.2); the fixed-to-per-pixel ratio is baked in. The heaptrack breakdown of a 1080p session is in [KNOWN_ISSUES.md](../KNOWN_ISSUES.md), under "FreeRDP allocates decode buffers it never uses", which also explains why about 18 B/px of it is FreeRDP allocating a second, unused codec set. Numbers will drift with FreeRDP versions and with the WebView; treat them as starting points, not facts.

**(c) Credentials and certificates.** A stored password is read from the OS credential store right before connecting and then goes to FreeRDP as `/p:` in the in-process argv (`freerdp.rs`). It never appears in the process list because no process is spawned, but FreeRDP logs a warning about passwords on the command line, and the string sits in memory as part of the argument vector. The planned fix is to set `FreeRDP_Password` through the settings API in the C bridge instead of parsing it from argv. Both backends skip server certificate verification (`/cert:ignore` for FreeRDP; a `NoCertificateVerification` verifier in `ironrdp.rs`), which is the equivalent of always clicking "continue" in mstsc. Fine on a trusted LAN, not fine elsewhere; there is no certificate pinning or first-use prompt.

**(d) Debug logging is on by default.** The default `tracing` filter in `lib.rs` is `warn,ironrdp_connector=debug,ironrdp_blocking=debug,iruka_lib=debug,iruka_perf=debug,iruka_mem=debug`, overridable with `IRUKA_LOG` (an `EnvFilter`). `iruka_perf` logs every queued and sent frame with sizes and timings plus key events; `iruka_mem` logs a memory sample every 3 s. This is intentional while the project is still being tuned, but it is noisy and should become opt-in (a `warn`-only default, with the debug targets enabled through `IRUKA_LOG`) before a release.

**(e) The IronRDP backend is a fallback only.** It does not implement RDPGFX, so GNOME Remote Desktop refuses it; it has no audio, no microphone and no clipboard (`ClipboardLocal` is ignored), and `enable_audio_playback` is false. It exists so that a build without libfreerdp still connects to Windows, and as a reference for a pure-Rust path. Do not expect feature parity.

**(f) UI strings are hard-coded English; there is no i18n layer.** Labels in `App.tsx`, `src/components` and `src/rdp.ts` (for example `RDP_BACKENDS`), dialog text, and the disconnect reasons returned from Rust ("Connection failed: …", "Disconnected", "The server closed the connection", "Communication error: …"; the UI shows them as "Connection error (FreeRDP): …" / "Disconnected (FreeRDP): …") are string literals in the code. Adding another language means introducing a message catalogue first.

**(g) Tests are thin.** There are no automated UI or end-to-end tests. Rust unit tests exist only for small helpers:

- `memory::tests::learns_scale_from_observations` — the model learns a scale from observations and applies it to another resolution
- `clipboard::tests::newlines_become_crlf_once` — CRLF normalisation is idempotent
- `rdp::tests::detects_own_addresses` — `is_local_host` recognises loopback and rejects a TEST-NET address

Run them with `cargo test` in `src-tauri`. Anything touching FreeRDP, the WebView or a real server is tested by hand.

## 4. Conventions

- Code comments and documentation are written in English. Japanese documents are kept as `*_JA.md` twins of the English files, with a one-line language switch at the top of each.
- While the project is pre-1.0, commits go directly to `main`; there are no feature branches or pull requests for the owner's own work.
- Problems whose cause is in FreeRDP (or the OS) are recorded in [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) rather than worked around in Iruka. The unused-codec-buffer issue there is the model: the workaround is written down, with the reasons it is not applied.
- The C bridge stays thin: it exposes a small C API (`iruka_rdp_*`) and keeps FreeRDP's own defaults by parsing a command line, so behaviour can be compared with `xfreerdp` when something goes wrong.
- Backends implement `RdpBackend` and nothing else; session management, frame delivery, clipboard and memory accounting stay in `rdp/mod.rs` and the shared modules.
