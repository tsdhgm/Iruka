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
- memory: `rdp_memory_check` (`memory.rs`)

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

### Input

The frontend converts `KeyboardEvent.code` to PC/AT Set 1 scancodes with the `SCANCODES` table in `src/rdp.ts` (extended keys are `0xE0xx`), so the layout is decided by the remote. Mouse coordinates are mapped to remote pixels by `toRemoteCoords`. Events are batched into `rdp_input` calls as `RdpInput` values (`MouseMove`, `MouseButton`, `Wheel`, `Key`, `ReleaseAll`); `ReleaseAll` is sent on blur to release modifier keys, since FreeRDP does not track key state.

### Frontend layout

`App.tsx` holds session state; forms, grid view, toolbar, modals and the host-key tracker live in `src/components` and `src/hostKey.ts`, and the per-session wiring (frame decoding for RDP, xterm.js for consoles) is in `src/rdpSession.ts` and `src/ptySession.ts`. The host-key tracker implements the "right Alt alone toggles the grid, right Alt + key is a normal Alt" rule: it holds the key-down until it knows whether another key follows.

### PTY sessions (consoles)

`pty.rs` uses `portable-pty`. `spawn_session` starts the requested program (or `$SHELL`, falling back to `bash`) with `TERM=xterm-256color` in the home directory, and spawns two threads: one streams output to the WebView as base64 over a `Channel<PtyEvent>`, the other waits for the child and sends `Exit`. The frontend renders with xterm.js and derives the "running / idle / exited" tile status from output timing.

### Memory model

`memory.rs` estimates how much memory one more RDP session will need, so the UI can warn before connecting. One session is modelled as `BASE_SESSION_BYTES + BASE_BYTES_PER_PIXEL × pixels`, multiplied by a learned scale. A background thread samples the memory of the whole process tree (Iruka plus the WebView and other children, threads excluded) every 3 s with `sysinfo`:

- With no RDP sessions open (after a 15 s warm-up), the lowest reading becomes the **baseline** for this run.
- With sessions open, `scale = (used − baseline) / base_estimate(sessions, pixels)` is appended to a list of observations (at most 1200, about an hour).
- The estimate uses the **95th percentile** of the observations once there are at least 20, times a **1.2 safety factor**. The observations are saved to `memory-model.json` in the app data directory every 60 s and loaded at start-up.

`rdp_memory_check` returns available memory (from the OS) and the estimate; in debug builds `IRUKA_FAKE_AVAILABLE_MB` fakes the available figure for testing the dialog. `lib.rs` also sets glibc's `M_MMAP_THRESHOLD` to 256 KB on Linux so large frame buffers go back to the OS when freed instead of lingering in per-thread arenas.

### Clipboard

Text only, and only for the session on screen. `clipboard.rs` keeps one `arboard::Clipboard` for the life of the process (on X11 the owner object must stay alive for other applications to read the data) and an `ACTIVE` session id. `rdp_set_active` (called by the frontend on focus changes) stores the id and pushes the local text to that session as `Command::ClipboardLocal`; `FrameSink::clipboard_from_remote` only writes to the local clipboard when the copying session is the active one. Line endings are normalised to CRLF towards the remote and to LF on non-Windows locally. In the C bridge, cliprdr is wired by `iruka_on_channel_connected`: the server's format list triggers a request for `CF_UNICODETEXT`, the response is stored in `remote_text` for the Rust loop to collect, and a server data request is answered from `local_text`.

## 2. Threading and the FFI boundary

Threads involved in one FreeRDP session:

| Thread | What runs on it |
|---|---|
| session thread (spawned by `rdp_connect`) | `RdpBackend::run`: the poll loop, all `iruka_rdp_*` calls, `FrameSink::flush` (pixel copy) |
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

**(c) Credentials and certificates.** The password goes to FreeRDP as `/p:` in the in-process argv (`freerdp.rs`). It never appears in the process list because no process is spawned, but FreeRDP logs a warning about passwords on the command line, and the string sits in memory as part of the argument vector. The planned fix is to set `FreeRDP_Password` through the settings API in the C bridge instead of parsing it from argv. Both backends skip server certificate verification (`/cert:ignore` for FreeRDP; a `NoCertificateVerification` verifier in `ironrdp.rs`), which is the equivalent of always clicking "continue" in mstsc. Fine on a trusted LAN, not fine elsewhere; there is no certificate pinning or first-use prompt.

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
