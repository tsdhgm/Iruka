*日本語版: [memory-reduction_JA.md](memory-reduction_JA.md)*

# Can a session use less memory? (study, 2026-10-26)

A record of a question and the answer worked out from what is already known; nothing here is
implemented. The owner wants to read FreeRDP's source carefully before changing anything, so this
page is the starting point for that, not a plan. The measurements it relies on are in
[code-notes.md](code-notes.md) "Memory model" and [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) ("FreeRDP
allocates decode buffers it never uses", with the heaptrack breakdown).

## The question

On the Windows client, six 3840×2160 sessions brought Iruka to about 7 GB (2026-10-26). Is there a
way to compress memory: raise the compression ratio (as with a JPEG quality setting) instead of
lowering the pixel count, or drop more frames? Or is it hopeless because Iruka as a whole is big?

## Short answer

Neither of those two reduces memory. But it is not hopeless either: the memory is not in "Iruka
as a whole" but in per-session buffers of decoded pixels, and those can be attacked in other ways.

## Why a higher compression ratio does not help

- The quality knobs of RDP (RemoteFX / Progressive quality, H.264 bit rate) only change how many
  bytes travel over the network.
- To show a screen, the client must decode it to raw pixels: 4 bytes per pixel, 32 MB for one
  3840×2160 frame, whatever the quality was.
- Almost all of a session's memory is buffers of that kind, sized by the desktop. The heaptrack
  breakdown of one 1920×1080 session (Linux, 2026-10-09) was: FreeRDP Planar decoder buffers (two
  sets) about 71 MB, Progressive decoder about 42 MB, other FreeRDP codecs (ClearCodec, zgfx…)
  about 40 MB, the drawing framebuffer about 8 MB, the WebView canvas about 30–45 MB, Iruka's own
  frame hand-off almost 0. Every line scales with the pixel count.
- H.264 / AVC444 would cut bandwidth, but its decoder adds memory rather than saving it.

## Why dropping more frames does not help

- Dropping frames saves CPU and the copy to the WebView, not resident memory: the buffers are
  allocated at desktop size when the session starts and stay that size.
- Iruka already drops frames: the end-to-end back-pressure of 2026-10-25 keeps one frame in flight
  per session and lets the rest go ([code-notes.md](code-notes.md) "Back-pressure, end to end").

## What would help (none of it done)

1. **A lower remote resolution while a session is only a thumbnail.** The largest lever. RDP can
   change the remote desktop size on a live connection (the Display Control virtual channel;
   FreeRDP's `/dynamic-resolution`). Receiving 1280×720 while a session sits in the grid and going
   back to 3840×2160 when it is enlarged would cut its decode buffers to about 1/9. Costs: the remote
   desktop re-lays out its windows on every change, the server has to support resizing, and
   FreeRDP's buffers must really shrink (see item 2: some of its reallocations never give memory
   back).
2. **Remove the buffers FreeRDP allocates and never uses.** About 150 MB per 3840×2160 session:
   `gdi_ResetGraphics` builds a second, unused set of codec buffers at desktop size (KNOWN_ISSUES.md).
   On Windows FreeRDP is built by us through vcpkg, so a patch (an overlay port) is possible; on
   Linux Iruka uses Ubuntu's package, so the fix would have to go upstream.
3. **Find out where Windows spends its extra memory.** One 3840×2160 session costs about 550 MB on
   Linux but about 1.2 GB on Windows. The 650 MB difference has not been measured. The suspect is
   the WebView2 side (32 MB frame messages, the canvas, GPU textures); the first step is splitting
   the reading between `iruka.exe` and the `msedgewebview2.exe` processes. If it is the WebView,
   downscaling frames in Rust for sessions shown only as thumbnails would reduce both that memory
   and the transfer cost behind the 10-second freeze seen the same day (a 32 MB frame took about
   1 s to reach the WebView in a debug build).
4. **Memory kept after a session closes** (Linux glibc malloc arenas): already in TODO.md,
   deferred by the owner.

Suggested order when this is picked up: measure item 3 first (cheap, and it decides whether the
WebView or FreeRDP is the bigger target), then read FreeRDP's gdi / RDPGFX code for items 2 and 1.

## Aside: Microsoft's Remote Desktop client

Microsoft's own client (mstsc / Windows App) feels much lighter with many large sessions. Not
measured, but the likely reasons are architectural: it draws into GPU surfaces through DirectX and
can decode H.264 in hardware, so decoded frames live in video memory rather than in the process's
private memory, and it has no browser engine between the decoder and the screen. Iruka decodes in
software into system memory (FreeRDP's gdi) and then copies each frame into a WebView canvas, so
every pixel is held at least twice.

### On a bad link

The owner's observation: on a laggy link Microsoft's client shows a coarse, JPEG-like screen that
sharpens later, and keeps the session alive. Part of that is the server, not the client:

- The coarse-then-sharp picture is the RDPGFX **Progressive** codec (RemoteFX Progressive): the
  server sends a rough version of each tile first and refines it when bandwidth allows. With
  **network auto-detect** the server measures round-trip time and bandwidth and lowers quality and
  frame rate. Iruka asks FreeRDP for both (`/gfx` and `/network:auto` in
  `src-tauri/src/rdp/freerdp.rs`), so against a Windows target Iruka should degrade the same way.
  Not yet observed.
- What Iruka probably lacks:
  - **UDP transport.** Microsoft's client can carry RDP over UDP (MS-RDPEUDP; RDP Shortpath in
    Azure Virtual Desktop), where a lost packet does not hold up everything behind it. FreeRDP's
    client is believed not to implement it, so Iruka runs over TCP only, and TCP waits for every
    retransmission; that is how a 9 s Wi-Fi stall dropped a session on 2026-10-25 (now
    `/timeout:60000` plus automatic reconnect).
  - **H.264.** See below.

### H.264 from Windows Server, and Iruka's build

- Windows Server 2016 and later (any edition, Datacenter included, on Azure VMs as well) and
  Windows 10/11 send H.264/AVC. By default it is a mix: text and static areas go through Progressive
  and the other codecs, only video-like areas through H.264. The group policy "Prioritize H.264/AVC
  444 graphics mode for Remote Desktop Connections" makes the whole screen AVC444.
- Most Azure VMs have no GPU, so the server encodes H.264 in software on its vCPUs (costly with
  much motion). GPU VMs (NV series) can encode in hardware, enabled by another policy.
- The server uses H.264 only when the client says it can decode it. Iruka's Windows build cannot:
  in vcpkg's FreeRDP 3.32.2 `freerdp/config.h` has `WITH_GFX_H264`, `WITH_OPENH264`,
  `WITH_MEDIA_FOUNDATION` and ffmpeg all undefined (checked 2026-10-26), so a Windows server sends
  Progressive and the other codecs instead. Ways to enable it: vcpkg's `ffmpeg` feature for FreeRDP
  (longer build, more DLLs), or a build with Windows' own Media Foundation decoder (probably no extra
  DLLs; not checked). The Linux client uses Ubuntu's FreeRDP package, which is probably built with
  ffmpeg and may already receive H.264; not checked.

### What H.264 would and would not buy

A natural follow-up question was whether ffmpeg (H.264) trades memory for CPU. It does not save
memory:

- **Memory goes up a little, not down.** The decoded result is the same 4-byte-per-pixel screen; the
  gdi framebuffer and the WebView canvas stay. The H.264 decoder adds its reference frames (a few,
  each a little over 10 MB at 3840×2160 in YUV 4:2:0), and FreeRDP still allocates its Progressive
  and other codec buffers. Expect tens of MB more per session; AVC444 runs two H.264 streams
  internally, so more.
- **Client CPU depends on how it decodes.** Software decoding of 4K H.264 is heavy, but Progressive
  is decoded in software today as well, so which one costs more depends on the screen content and
  has to be measured. ffmpeg can also decode on the GPU (FreeRDP's `WITH_FFMPEG_HWACCEL`: D3D11 and
  others on Windows, VA-API on Linux), which takes most of the work off the CPU; FreeRDP still
  copies the result back to system memory to compose its gdi frame, so this saves CPU, not memory
  (Microsoft's client keeps decoded frames on the GPU).
- **Server CPU goes up** on a GPU-less VM, which encodes H.264 on its vCPUs: the watched machine
  pays for heavy motion.
- **For monitoring**, mostly static screens send little data whatever the codec, so H.264 gains
  little there. It pays off for video or constant full-screen motion over a thin link, such as the
  session that kept sending full 4K frames on 2026-10-26.

In short, H.264 buys bandwidth and resilience on a bad link, paid in CPU (and a little memory).
The memory levers are the ones above: a lower resolution for thumbnails and FreeRDP's unused buffers.
