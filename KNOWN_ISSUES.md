*日本語版: [KNOWN_ISSUES_JA.md](KNOWN_ISSUES_JA.md)*

# Known Issues

Known bugs and limitations. Problems whose cause lies outside Iruka (FreeRDP or the OS) are recorded here rather than worked around.

## The Win key, Alt+Tab and Print Screen do not reach the remote

- **Status**: not addressed (parked as a Known Bug on 2026-10-09)
- **Symptom**: the Win key, Win+Space, Alt+Tab and similar are handled by the local desktop instead of the remote. Same whether the target is Windows or Ubuntu (GNOME Remote Desktop).
  Print Screen (and Alt+Print, Shift+Print) too: GNOME takes it for its screenshot UI, so screenshots cannot be taken on the remote with the key (noticed 2026-10-24). Iruka's scancode table does have `PrintScreen`; since 2026-10-24 the toolbar has a Print Screen button (⎙) that presses the key on the remote instead (the owner preferred it to a keyboard grab, which has side effects on the local desktop). Ctrl+Print is not grabbed locally and reaches the remote, where Windows treats it like Print.
  Owner's practice (2026-10-24): the button is for the occasional screenshot; a series of them, e.g. for a manual, is taken with Remmina (keyboard grab) or at the machine itself.
- **Cause**: the local GNOME grabs these keys first as system shortcuts. It is not a FreeRDP limitation. Remmina and mstsc avoid it by grabbing the keyboard exclusively.
- **If it is to be fixed**:
  - Linux: a GTK keyboard grab, or the Wayland keyboard-shortcuts-inhibit protocol (GTK 3's Wayland backend implements it; GNOME asks the user once and Super+Esc restores the shortcuts).
  - **Workaround without code for Print Screen**: move GNOME's screenshot shortcuts to other keys, then Print reaches the remote: `gsettings set org.gnome.shell.keybindings show-screenshot-ui "['<Ctrl>Print']"`, likewise `screenshot-window` (`<Alt>Print` → `<Ctrl><Alt>Print`) and `screenshot` (`<Shift>Print` → `<Ctrl><Shift>Print`); `gsettings reset` undoes it. The Win key has no such workaround (Win+Shift+S still needs Win).
  - Windows: a low-level keyboard hook (`WH_KEYBOARD_LL`), the same approach as mstsc.

## Option+V paste does not work on a Mac (macrdp)

- **Status**: parked (2026-10-13)
- **Symptom**: when connected to a Mac running clintcan/macrdp, Option+V does not paste. Clipboard sharing itself works in both directions, and pasting by other means (the menu, for example) works.
- **Cause**: not investigated. Iruka sends Alt as the RDP scancode (left Alt = 0x38); whether the Mac maps it to Option or Command depends on macrdp's translation. Iruka uses the right Alt for the grid-view toggle, so test with the left Alt rather than a lone right Alt (see "View toggle key" in the README).
- **If it is to be fixed**: check macrdp's key translation settings (Cmd-key shortcut emulation). No change on Iruka's side is expected.

## Clipboard is text only

- **Status**: limitation (2026-10-09)
- **Details**: only text is shared. Images and files cannot be copied and pasted. When connected through IronRDP, text is not shared either.
- **Reason**: text was judged sufficient for a monitoring tool. Images are little extra work and can be added if needed. Files need a separate mechanism that transfers file contents in chunks (cliprdr FileContents), which is considerably more work.
- **Related**: only the session on screen is synchronised (see "Clipboard" in the README). This is by design, so that a copy in a background session does not overwrite the local clipboard.

## Windows: vcpkg's OpenSSL does not find its legacy provider (NTLM)

- **Status**: worked around in the environment; with `OPENSSL_MODULES` set the warnings are gone and NLA (NTLM) to a Windows target works (2026-10-16)
- **Symptom**: on connect, FreeRDP logs `[SSL] {Digest} build or configuration missing: md4: NTLM support not available` and `rc4: … NTLM and autoreconnect cookies will not work`. GNOME Remote Desktop still connects; a Windows target that uses NLA with NTLM is expected to fail.
- **Cause**: OpenSSL 3 keeps MD4 and RC4 in the "legacy" provider (`legacy.dll`). vcpkg's `libcrypto-3-x64.dll` is built with `MODULESDIR` = `C:\Program Files\OpenSSL\bin`, so it looks there, not in vcpkg's `bin` where `legacy.dll` actually is.
- **Fix**: set `OPENSSL_MODULES` to the folder holding `legacy.dll` (vcpkg's `installed\x64-windows\bin`) before Iruka starts. For an installer, ship `legacy.dll` next to `iruka.exe` and have Iruka set `OPENSSL_MODULES` to its own folder at startup when the variable is unset.

## Linux: starting Iruka a second time kills the running Iruka

- **Status**: found 2026-10-24 (by accident, while testing a launcher); open, fix candidates in TODO.md. Iruka-side.
- **Symptom**: with Iruka running, a second start (dock click, `iruka` in a terminal) exits at once with status 0, and the *running* Iruka ends with status 101 and `thread 'main' panicked at tauri-2.11.5/src/app.rs:1425: Failed to setup app: a webview with label 'main' already exists` on stderr. Open sessions are lost.
- **Cause**: `enableGTKAppId: true` in tauri.conf.json makes the process a `GtkApplication` with id `dev.tosihide.iruka`. GApplication treats the second process as a remote instance: it forwards `activate` to the primary and exits. The primary's event loop (tao) reports a second `Ready`, Tauri runs `setup` again and tries to create the `main` window, which already exists; the error is a panic.
- **Fix candidates**: (1) `tauri-plugin-single-instance`, so the second start focuses the existing window; (2) `enableGTKAppId: false`, then a second start is a second independent Iruka (check that the dock still matches the window: the Wayland app id is the binary name, matched by `StartupWMClass=iruka`).
- Diagnosis how-to and the record: docs/linux-diagnostics.md, docs/linux-diagnostics-log.md.

## Linux: the whole app is killed (SIGKILL) under heavy load, e.g. while OBS captures the screen

- **Status**: cause identified 2026-10-23; recorded only, by the owner's decision (candidate workaround in TODO.md). Full investigation and Q&A: docs/realtime-kill.md; general diagnosis how-to: docs/linux-diagnostics.md
- **Symptom**: with several 3840×2160 sessions open, and reliably while OBS Studio captures the 4K display through PipeWire, Iruka disappears after one to a few minutes. Nothing is logged: no crash report, no kernel OOM, no message from Iruka, GTK or FreeRDP. Under gdb: `Program terminated with signal SIGKILL`.
- **Cause**: WebKitGTK (WTF `RealTimeThreads`, seen with WebKitGTK 2.52.6) asks RealtimeKit to put its IPC receive threads (`ReceiveQueue`, two in the UI process) on `SCHED_RR` priority 5, and sets `RLIMIT_RTTIME` to RealtimeKit's maximum (hard 200 ms, soft 160 ms). The kernel kills a process whose real-time thread uses more than `RLIMIT_RTTIME` of CPU without blocking. With Iruka's IPC volume (frames for several 4K sessions through WebKit's IPC) plus OBS competing for the CPU, a receive thread runs for more than 200 ms without blocking and the kernel sends SIGKILL to the whole process. Confirmed with bpftrace on `signal_generate`: `sig=9 to ReceiveQueue(...) from ReceiveQueue(same process) code=128` (SI_KERNEL). WebKit installs a SIGXCPU handler to demote its threads at the soft limit, but the trace showed no SIGXCPU before the SIGKILL (kernel 7.0, HZ=1000), so that safety net did not help.
- **How to confirm**: `sudo bpftrace -e 'tracepoint:signal:signal_generate /args->sig == 9/ { printf("%s to %s(%d) from %s(%d) code=%d\n", strftime("%H:%M:%S", nsecs), args->comm, args->pid, comm, pid, args->code); }'` and reproduce. `ps -L -o tid,cls,rtprio,comm -p $(pgrep -x iruka)` lists the `RR` threads; `grep realtime /proc/$(pgrep -x iruka)/limits` shows the limit.
- **Workaround without code** (verified 2026-10-23 in real use: no kill while OBS captured the 4K display, but Iruka responds noticeably slower while OBS runs; audio and clipboard not checked): start Iruka with `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent`; WebKit then cannot reach RealtimeKit, the threads stay `SCHED_OTHER` and no limit is set. For the dock: copy `/usr/share/applications/Iruka.desktop` to `~/.local/share/applications/` with `Exec=env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent iruka`. Details and caveats in docs/realtime-kill.md.
- **If it is to be fixed**: the limit cannot be raised (RealtimeKit caps it at 200 ms and a process can only lower its hard limit). Options: (1) demote the `ReceiveQueue` threads of the own process back to `SCHED_OTHER` from Iruka (`sched_setscheduler` on the threads in `/proc/self/task` whose policy is `SCHED_RR`; WebKit re-promotes them when a view becomes visible, so repeat it from the existing memory sampler thread), at the cost of slightly higher IPC latency, which Iruka does not need; (2) report upstream to WebKitGTK that the SIGXCPU safety net did not fire; (3) reduce Iruka's IPC volume (fewer or smaller frames), which only moves the threshold.

## A terminal spinner on a remote desktop costs as much as a video

- **Status**: understood 2026-10-25; nothing to fix in Iruka, a usage note.
- **Symptom**: an "idle" Ubuntu remote (10.0.1.53, GNOME Remote Desktop) sent more screen data than the one playing a YouTube video: about 10 frames per second, each a quarter of a 3840×2160 screen (85 MB/s decoded, 0.9 MB/s on the wire). On a small client box this is what fills the frame queue (docs/code-notes.md weak spot (h)).
- **Cause**: a terminal window on that remote ran an AI CLI (grok) whose status line redraws in place several times a second. The remote desktop server sends the damaged region at roughly window granularity, so a few changing characters cost the whole terminal window each time. Any spinner, `top`, a ticking clock or a live dashboard does the same (10.0.1.113's clock dashboard: 0.2 to 0.7 MB/s).
- **How to confirm**: `ss -tin state established '( dport = :3389 )'` twice, 20 s apart, and compare `bytes_received` per host; replacing or minimising the terminal brought 10.0.1.53 to 0 at once.
- **What to do**: keep such windows minimised (a minimised window generates no damage) or on a workspace that is not shown, or lower that session's resolution. Iruka cannot tell a spinner from a video; a future frame-rate cap per session (TODO.md) would limit the cost but not the waste.

## FreeRDP allocates decode buffers it never uses

- **Status**: parked as a FreeRDP-side problem (2026-10-09)
- **Symptom**: each RDP session wastes about 18 bytes of memory per pixel: about 35 MB at 1920×1080, about 150 MB at 3840×2160.
- **Cause**: `gdi_ResetGraphics` in FreeRDP 3.32.1 (`libfreerdp/gdi/gfx.c`) recreates **two** full sets of decoder buffers (Planar, Progressive, ClearCodec and so on) at desktop size every time the server resets the graphics:
  - one set for RDPGFX (used for drawing)
  - `context->codecs` for legacy screen updates (unused while connected through RDPGFX)

  The Planar buffer of the latter alone comes to about 18 bytes per pixel.
- **Iruka-side code that triggers it**:
  - the `/gfx` argument in `src-tauri/src/rdp/freerdp.rs`
  - `iruka_pre_connect` in `src-tauri/native/freerdp_bridge.c` (which attaches RDPGFX to gdi)
- **If Iruka were to work around it**: wrap `ResetGraphics`, and after the original handler runs, free `context->codecs` and recreate it at a minimal size (see "Reference: workaround code" below).
  - FreeRDP's `winpr_aligned_offset_recalloc` does not return memory when shrinking, so simply resetting at a smaller size does not reduce usage.
  - If the server sends the screen the legacy way, decoding fails and the session may be dropped.
  - There is a risk of freeing a buffer that another thread is using.

  For these reasons the workaround is not applied.
- **Going forward**: when FreeRDP is built in-house (for the Windows build and so on), consider fixing FreeRDP itself (allocate on first use, or propose a fix upstream).

### Reference: workaround code

Illustrative code (not applied in Iruka). It would go in `freerdp_bridge.c`.

```c
/* Wrap the ResetGraphics that gdi installs (called every time the server resets the graphics) */
static pcRdpgfxResetGraphics gdi_reset_graphics; /* the original gdi_ResetGraphics */

static UINT iruka_reset_graphics(RdpgfxClientContext* gfx, const RDPGFX_RESET_GRAPHICS_PDU* pdu)
{
	/* Here gdi recreates both sets (RDPGFX and legacy) at desktop size */
	UINT rc = gdi_reset_graphics(gfx, pdu);
	if (rc != CHANNEL_RC_OK)
		return rc;

	/* Free the legacy set (unused during RDPGFX) and recreate it at a minimal size.
	 * A shrinking reset does not return memory in FreeRDP, so it has to be recreated */
	rdpGdi* gdi = (rdpGdi*)gfx->custom;
	rdpContext* context = gdi->context;
	rdpSettings* settings = context->settings;
	rdpCodecs* small = freerdp_client_codecs_new(
	    freerdp_settings_get_uint32(settings, FreeRDP_ThreadingFlags));
	if (!small || !freerdp_client_codecs_prepare(small,
	                  freerdp_settings_get_codecs_flags(settings), 64, 64))
	{
		freerdp_client_codecs_free(small);
		return CHANNEL_RC_OK; /* on failure keep using the original */
	}
	freerdp_client_codecs_free(context->codecs);
	context->codecs = small;
	return CHANNEL_RC_OK;
}

/* On channel connect: after FreeRDP's common handler attaches gdi, swap in our ResetGraphics */
static void iruka_on_channel_connected(void* ctx, const ChannelConnectedEventArgs* e)
{
	freerdp_client_OnChannelConnectedEventHandler(ctx, e);
	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
	{
		RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
		/* If the channel reconnects, saving ourselves would recurse forever */
		if (gfx->ResetGraphics != iruka_reset_graphics)
		{
			gdi_reset_graphics = gfx->ResetGraphics;
			gfx->ResetGraphics = iruka_reset_graphics;
		}
	}
}
```

To use it, change the handler subscribed in `iruka_pre_connect` from `freerdp_client_OnChannelConnectedEventHandler` to `iruka_on_channel_connected` (the disconnect side, `freerdp_client_OnChannelDisconnectedEventHandler`, stays as is).

### Reference: breakdown of one 1920×1080 session (heaptrack, 2026-10-09)

| What it is used for | Amount |
|---|---|
| FreeRDP Planar decoder buffers (two sets) | about 71 MB |
| FreeRDP Progressive decoder buffers | about 42 MB |
| FreeRDP, other (ClearCodec, zgfx, etc.) | about 40 MB |
| FreeRDP drawing framebuffer | about 8 MB |
| WebView side (canvas, etc.) | about 30–45 MB |
| Iruka's own frame hand-off | almost 0 |
