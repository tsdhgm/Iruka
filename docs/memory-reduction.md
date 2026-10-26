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
