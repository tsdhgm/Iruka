*日本語版: [KNOWN_ISSUES_JA.md](KNOWN_ISSUES_JA.md)*

# Known Issues

Known bugs and limitations. Problems whose cause lies outside Iruka (FreeRDP or the OS) are recorded here rather than worked around.

## The Win key and Alt+Tab do not reach the remote

- **Status**: not addressed (parked as a Known Bug on 2026-10-09)
- **Symptom**: the Win key, Win+Space, Alt+Tab and similar are handled by the local desktop instead of the remote. Same whether the target is Windows or Ubuntu (GNOME Remote Desktop).
- **Cause**: the local GNOME grabs these keys first as system shortcuts. It is not a FreeRDP limitation. Remmina and mstsc avoid it by grabbing the keyboard exclusively.
- **If it is to be fixed**:
  - Linux: a GTK keyboard grab, or the Wayland keyboard-shortcuts-inhibit protocol.
  - Windows: a low-level keyboard hook (`WH_KEYBOARD_LL`), the same approach as mstsc.

## The mouse cursor shape does not follow the remote

- **Status**: limitation (2026-10-09)
- **Symptom**: over the RDP view the cursor is always the local arrow. It does not become a resize shape (↔ and so on) over window borders, nor an I-beam over text or a hand over links. The operations themselves (resizing by dragging a border, for example) work.
- **Cause**: in RDP the cursor is not part of the screen image; its shape arrives separately as pointer updates, and the client shows it as the local cursor (to avoid lag). Iruka ignores that information and always shows the local arrow (`cursor: default` on `.rdp-canvas` in `src/App.css`).
- **If it is to be fixed**:
  - Receive FreeRDP's pointer updates (New / Set / SetNull / SetDefault) in `freerdp_bridge.c` and convert the cursor image to RGBA.
  - Send it to the frontend together with the hotspot and set it as the canvas's CSS `cursor: url(...) x y`.
  - At high display scale factors (4K and the like) the cursor image gets large. Whether the WebView has limits on cursor size or scale handling needs checking.

## Option+V paste does not work on a Mac (macrdp)

- **Status**: parked (2026-10-13)
- **Symptom**: when connected to a Mac running clintcan/macrdp, Option+V does not paste. Clipboard sharing itself works in both directions, and pasting by other means (the menu, for example) works.
- **Cause**: not investigated. Iruka sends Alt as the RDP scancode (left Alt = 0x38); whether the Mac maps it to Option or Command depends on macrdp's translation. Iruka uses the right Alt for the grid-view toggle, so test with the left Alt rather than a lone right Alt (see "View toggle key" in the README).
- **If it is to be fixed**: check macrdp's key translation settings (Cmd-key shortcut emulation). No change on Iruka's side is expected.

## GNOME Remote Desktop goes black while another client is connected

- **Status**: limitation of the target (2026-10-15)
- **Symptom**: with Iruka connected to an Ubuntu GNOME Remote Desktop target, connecting a second client (for example Remmina) to the same machine turns Iruka's view of it black. The session is not disconnected and no error is shown. Once the second client disconnects, the picture comes back the next time the screen is repainted (switching sessions or the view triggers a full repaint).
- **Cause**: GNOME Remote Desktop's screen-sharing mode serves one client at a time; the earlier client stops receiving real frames. Windows behaves differently and disconnects the earlier session, which Iruka reports as "Disconnected (FreeRDP): …".
- **Workaround**: keep one client per GNOME Remote Desktop target. Power or screen-blanking settings on the target may add similar black periods; not investigated.

## Clipboard is text only

- **Status**: limitation (2026-10-09)
- **Details**: only text is shared. Images and files cannot be copied and pasted. When connected through IronRDP, text is not shared either.
- **Reason**: text was judged sufficient for a monitoring tool. Images are little extra work and can be added if needed. Files need a separate mechanism that transfers file contents in chunks (cliprdr FileContents), which is considerably more work.
- **Related**: only the session on screen is synchronised (see "Clipboard" in the README). This is by design, so that a copy in a background session does not overwrite the local clipboard.

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
