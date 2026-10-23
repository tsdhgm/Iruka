/*
 * Thin bridge between Iruka and FreeRDP 3.
 *
 * Structured like FreeRDP's official headless sample (client/Sample/tf_freerdp.c):
 * no GUI toolkit, just the gdi (software rendering) framebuffer. RDPGFX output
 * (Progressive / RemoteFX / H.264) is composed into primary_buffer by gdi as well,
 * so the Rust side only has to read the changed rectangles and the framebuffer.
 *
 * All functions must be called from the single thread that owns the session.
 * The one exception is clipboard (cliprdr) notifications, which arrive on FreeRDP's
 * channel thread; that hand-off alone is protected by a lock.
 */

#include <stdint.h>
#include <string.h>

#include <winpr/synch.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/codec/color.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/graphics.h>
#include <freerdp/input.h>
#include <freerdp/scancode.h>
#include <winpr/string.h>
#include <winpr/user.h>

/* Maximum number of pending dirty rectangles. Beyond this they are collapsed into one rectangle */
#define MAX_DIRTY 128

typedef struct
{
	INT32 x, y, w, h;
} DirtyRect;

/* Cursor ids handed to Rust: 0 and 1 are reserved, pointer images get 2 and up */
#define CURSOR_DEFAULT 0 /* the local default arrow */
#define CURSOR_HIDDEN 1  /* no cursor (the server hid it) */

/* A cursor shape received from the server, converted to RGBA, waiting for Rust to take it */
typedef struct cursor_image
{
	struct cursor_image* next;
	uint32_t id, width, height, hot_x, hot_y;
	uint8_t* rgba; /* width * height * 4 bytes, in the order R, G, B, A */
} CursorImage;

/* FreeRDP's pointer object, extended with the id Iruka gave its image */
typedef struct
{
	rdpPointer base;
	uint32_t id;
} IrukaPointer;

typedef struct
{
	rdpClientContext common;

	/* Regions changed since the last iruka_rdp_take_dirty() */
	DirtyRect dirty[MAX_DIRTY];
	int ndirty;

	/* Cursor shape (pointer updates, see "Pointer" below). Poll thread only */
	uint32_t next_cursor_id;
	CursorImage* cursor_images; /* images not yet taken by Rust, oldest first */
	uint32_t cursor_id;         /* what the server wants shown now */
	BOOL cursor_changed;        /* cursor_id changed since the last iruka_rdp_take_cursor() */

	/* Clipboard (text only). Protected by clip_lock */
	CRITICAL_SECTION clip_lock;
	CliprdrClientContext* cliprdr;
	BOOL clip_ready;   /* Monitor Ready has been received from the server */
	char* local_text;  /* Local text (UTF-8). Handed to the server when it asks for it */
	char* remote_text; /* Text copied on the remote side (UTF-8). Held until Rust picks it up */
} IrukaContext;

/* Collapse the pending regions into one rectangle that covers them all */
static void collapse_dirty(IrukaContext* ic)
{
	if (ic->ndirty <= 1)
		return;
	INT32 left = ic->dirty[0].x, top = ic->dirty[0].y;
	INT32 right = left + ic->dirty[0].w, bottom = top + ic->dirty[0].h;
	for (int i = 1; i < ic->ndirty; i++)
	{
		const DirtyRect* r = &ic->dirty[i];
		if (r->x < left)
			left = r->x;
		if (r->y < top)
			top = r->y;
		if (r->x + r->w > right)
			right = r->x + r->w;
		if (r->y + r->h > bottom)
			bottom = r->y + r->h;
	}
	ic->dirty[0] = (DirtyRect){ left, top, right - left, bottom - top };
	ic->ndirty = 1;
}

static void add_dirty(IrukaContext* ic, INT32 x, INT32 y, INT32 w, INT32 h)
{
	if (w <= 0 || h <= 0)
		return;
	if (ic->ndirty == MAX_DIRTY)
		collapse_dirty(ic);
	ic->dirty[ic->ndirty++] = (DirtyRect){ x, y, w, h };
}

static BOOL iruka_begin_paint(rdpContext* context)
{
	rdpGdi* gdi = context->gdi;
	gdi->primary->hdc->hwnd->invalid->null = TRUE;
	return TRUE;
}

/*
 * Called when one frame has been composed. Records the changed regions.
 * hwnd->invalid is a single rectangle covering everything, so two distant changes
 * make it huge. Use the list of individual regions (cinvalid) instead, and reset the
 * count to 0 once read (as xfreerdp does).
 */
static BOOL iruka_end_paint(rdpContext* context)
{
	rdpGdi* gdi = context->gdi;
	HGDI_WND hwnd = gdi->primary->hdc->hwnd;
	if (!hwnd)
		return TRUE;
	IrukaContext* ic = (IrukaContext*)context;
	if (hwnd->invalid && !hwnd->invalid->null)
	{
		for (INT32 i = 0; i < hwnd->ninvalid; i++)
		{
			const GDI_RGN* r = &hwnd->cinvalid[i];
			add_dirty(ic, r->x, r->y, r->w, r->h);
		}
	}
	hwnd->ninvalid = 0;
	return TRUE;
}

/* The server changed the screen size (reactivation, or RDPGFX ResetGraphics) */
static BOOL iruka_desktop_resize(rdpContext* context)
{
	rdpSettings* settings = context->settings;
	IrukaContext* ic = (IrukaContext*)context;
	if (!gdi_resize(context->gdi, freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth),
	                freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight)))
		return FALSE;
	ic->ndirty = 0;
	return TRUE;
}

/* ---- Pointer (cursor shape) ----
 *
 * In RDP the cursor is not part of the screen image: the server sends its shape as
 * pointer updates and the client shows it as the local cursor, so it moves without
 * lag. FreeRDP keeps a cache of pointers and calls New when a shape arrives, Set when
 * the server selects one (also from the cache), SetNull to hide it and SetDefault for
 * the ordinary arrow. These run on the poll thread: pointer updates travel on the main
 * channel, which iruka_rdp_poll processes. Each new shape is converted to RGBA and
 * queued once (cursor_images); the selection is a cursor id (cursor_id). Rust takes
 * both after every poll and the frontend sets the canvas's CSS cursor from them.
 */

static BOOL iruka_pointer_new(rdpContext* context, rdpPointer* pointer)
{
	IrukaContext* ic = (IrukaContext*)context;
	IrukaPointer* ip = (IrukaPointer*)pointer;
	const UINT32 w = pointer->width, h = pointer->height;
	ip->id = CURSOR_DEFAULT; /* shown instead if the image cannot be converted */
	if (w == 0 || h == 0 || w > 256 || h > 256 || !context->gdi)
		return TRUE;
	CursorImage* img = calloc(1, sizeof(*img));
	if (!img)
		return TRUE;
	img->rgba = malloc((size_t)w * h * 4);
	if (!img->rgba ||
	    !freerdp_image_copy_from_pointer_data(img->rgba, PIXEL_FORMAT_RGBA32, w * 4, 0, 0, w, h,
	                                          pointer->xorMaskData, pointer->lengthXorMask,
	                                          pointer->andMaskData, pointer->lengthAndMask,
	                                          pointer->xorBpp, &context->gdi->palette))
	{
		free(img->rgba);
		free(img);
		return TRUE;
	}
	ip->id = ic->next_cursor_id++;
	img->id = ip->id;
	img->width = w;
	img->height = h;
	img->hot_x = pointer->xPos;
	img->hot_y = pointer->yPos;
	CursorImage** tail = &ic->cursor_images;
	while (*tail)
		tail = &(*tail)->next;
	*tail = img;
	return TRUE;
}

static void iruka_pointer_free(rdpContext* context, rdpPointer* pointer)
{
	/* The pixel data belongs to FreeRDP; the queued copy (if still queued) is Rust's to take */
	WINPR_UNUSED(context);
	WINPR_UNUSED(pointer);
}

static void set_cursor(IrukaContext* ic, uint32_t id)
{
	ic->cursor_id = id;
	ic->cursor_changed = TRUE;
}

static BOOL iruka_pointer_set(rdpContext* context, rdpPointer* pointer)
{
	set_cursor((IrukaContext*)context, ((IrukaPointer*)pointer)->id);
	return TRUE;
}

static BOOL iruka_pointer_set_null(rdpContext* context)
{
	set_cursor((IrukaContext*)context, CURSOR_HIDDEN);
	return TRUE;
}

static BOOL iruka_pointer_set_default(rdpContext* context)
{
	set_cursor((IrukaContext*)context, CURSOR_DEFAULT);
	return TRUE;
}

static BOOL iruka_pointer_set_position(rdpContext* context, UINT32 x, UINT32 y)
{
	/* The server moved its cursor; the local cursor stays where the user has it */
	WINPR_UNUSED(context);
	WINPR_UNUSED(x);
	WINPR_UNUSED(y);
	return TRUE;
}

static void free_cursor_images(IrukaContext* ic)
{
	while (ic->cursor_images)
	{
		CursorImage* img = ic->cursor_images;
		ic->cursor_images = img->next;
		free(img->rgba);
		free(img);
	}
}

/* ---- Clipboard (cliprdr, text only) ----
 *
 * Remote -> local: the server announces a copy (Format List) -> request it if there is text
 *   -> when it arrives, store it in remote_text -> Rust picks it up with iruka_rdp_take_remote_text().
 * Local -> remote: Rust hands text over with iruka_rdp_set_local_text() -> announce it to the server
 *   -> when the server asks for it on paste, return local_text.
 */

static IrukaContext* clip_owner(CliprdrClientContext* cliprdr)
{
	return (IrukaContext*)cliprdr->custom;
}

/* Announce to the server which formats we have, according to the current local_text */
static UINT clip_send_format_list(IrukaContext* ic)
{
	CLIPRDR_FORMAT format = { .formatId = CF_UNICODETEXT, .formatName = NULL };
	CLIPRDR_FORMAT_LIST list = { .common.msgType = CB_FORMAT_LIST };
	EnterCriticalSection(&ic->clip_lock);
	CliprdrClientContext* cliprdr = ic->clip_ready ? ic->cliprdr : NULL;
	if (ic->local_text && ic->local_text[0])
	{
		list.numFormats = 1;
		list.formats = &format;
	}
	LeaveCriticalSection(&ic->clip_lock);
	if (!cliprdr)
		return CHANNEL_RC_OK;
	return cliprdr->ClientFormatList(cliprdr, &list);
}

static UINT clip_monitor_ready(CliprdrClientContext* cliprdr, const CLIPRDR_MONITOR_READY* ready)
{
	WINPR_UNUSED(ready);
	IrukaContext* ic = clip_owner(cliprdr);
	CLIPRDR_GENERAL_CAPABILITY_SET general = { .capabilitySetType = CB_CAPSTYPE_GENERAL,
		                                       .capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN,
		                                       .version = CB_CAPS_VERSION_2,
		                                       .generalFlags = CB_USE_LONG_FORMAT_NAMES };
	CLIPRDR_CAPABILITIES caps = { .cCapabilitiesSets = 1,
		                          .capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general };
	UINT rc = cliprdr->ClientCapabilities(cliprdr, &caps);
	if (rc != CHANNEL_RC_OK)
		return rc;
	EnterCriticalSection(&ic->clip_lock);
	ic->clip_ready = TRUE;
	LeaveCriticalSection(&ic->clip_lock);
	return clip_send_format_list(ic);
}

static UINT clip_server_capabilities(CliprdrClientContext* cliprdr,
                                     const CLIPRDR_CAPABILITIES* caps)
{
	WINPR_UNUSED(cliprdr);
	WINPR_UNUSED(caps);
	return CHANNEL_RC_OK;
}

/* Something was copied on the remote side: request the contents if there is text */
static UINT clip_server_format_list(CliprdrClientContext* cliprdr,
                                    const CLIPRDR_FORMAT_LIST* list)
{
	const CLIPRDR_FORMAT_LIST_RESPONSE response = { .common.msgType = CB_FORMAT_LIST_RESPONSE,
		                                            .common.msgFlags = CB_RESPONSE_OK };
	UINT rc = cliprdr->ClientFormatListResponse(cliprdr, &response);
	if (rc != CHANNEL_RC_OK)
		return rc;
	for (UINT32 i = 0; i < list->numFormats; i++)
	{
		if (list->formats[i].formatId == CF_UNICODETEXT)
		{
			const CLIPRDR_FORMAT_DATA_REQUEST request = { .common.msgType = CB_FORMAT_DATA_REQUEST,
				                                          .requestedFormatId = CF_UNICODETEXT };
			return cliprdr->ClientFormatDataRequest(cliprdr, &request);
		}
	}
	return CHANNEL_RC_OK;
}

static UINT clip_server_format_list_response(CliprdrClientContext* cliprdr,
                                             const CLIPRDR_FORMAT_LIST_RESPONSE* response)
{
	WINPR_UNUSED(cliprdr);
	WINPR_UNUSED(response);
	return CHANNEL_RC_OK;
}

/* The requested text arrived (UTF-16LE, may include a terminating NUL) */
static UINT clip_server_format_data_response(CliprdrClientContext* cliprdr,
                                             const CLIPRDR_FORMAT_DATA_RESPONSE* response)
{
	IrukaContext* ic = clip_owner(cliprdr);
	if (response->common.msgFlags != CB_RESPONSE_OK || !response->requestedFormatData)
		return CHANNEL_RC_OK;
	const WCHAR* wtext = (const WCHAR*)response->requestedFormatData;
	size_t wlen = response->common.dataLen / sizeof(WCHAR);
	while (wlen > 0 && wtext[wlen - 1] == 0)
		wlen--;
	char* text = ConvertWCharNToUtf8Alloc(wtext, wlen, NULL);
	if (!text)
		return CHANNEL_RC_OK;
	EnterCriticalSection(&ic->clip_lock);
	free(ic->remote_text);
	ic->remote_text = text;
	LeaveCriticalSection(&ic->clip_lock);
	return CHANNEL_RC_OK;
}

/* Paste on the remote side: hand over the local text */
static UINT clip_server_format_data_request(CliprdrClientContext* cliprdr,
                                            const CLIPRDR_FORMAT_DATA_REQUEST* request)
{
	IrukaContext* ic = clip_owner(cliprdr);
	CLIPRDR_FORMAT_DATA_RESPONSE response = { .common.msgType = CB_FORMAT_DATA_RESPONSE,
		                                      .common.msgFlags = CB_RESPONSE_FAIL };
	WCHAR* wtext = NULL;
	size_t wlen = 0;
	if (request->requestedFormatId == CF_UNICODETEXT)
	{
		EnterCriticalSection(&ic->clip_lock);
		if (ic->local_text)
			wtext = ConvertUtf8ToWCharAlloc(ic->local_text, &wlen);
		LeaveCriticalSection(&ic->clip_lock);
	}
	if (wtext)
	{
		/* Send the terminating NUL as well */
		response.common.msgFlags = CB_RESPONSE_OK;
		response.common.dataLen = (UINT32)((wlen + 1) * sizeof(WCHAR));
		response.requestedFormatData = (const BYTE*)wtext;
	}
	UINT rc = cliprdr->ClientFormatDataResponse(cliprdr, &response);
	free(wtext);
	return rc;
}

static void iruka_on_channel_connected(void* context, const ChannelConnectedEventArgs* e)
{
	IrukaContext* ic = (IrukaContext*)context;
	if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) != 0)
		return;
	CliprdrClientContext* cliprdr = (CliprdrClientContext*)e->pInterface;
	cliprdr->custom = ic;
	cliprdr->MonitorReady = clip_monitor_ready;
	cliprdr->ServerCapabilities = clip_server_capabilities;
	cliprdr->ServerFormatList = clip_server_format_list;
	cliprdr->ServerFormatListResponse = clip_server_format_list_response;
	cliprdr->ServerFormatDataResponse = clip_server_format_data_response;
	cliprdr->ServerFormatDataRequest = clip_server_format_data_request;
	EnterCriticalSection(&ic->clip_lock);
	ic->cliprdr = cliprdr;
	LeaveCriticalSection(&ic->clip_lock);
}

static void iruka_on_channel_disconnected(void* context, const ChannelDisconnectedEventArgs* e)
{
	IrukaContext* ic = (IrukaContext*)context;
	if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) != 0)
		return;
	EnterCriticalSection(&ic->clip_lock);
	ic->cliprdr = NULL;
	ic->clip_ready = FALSE;
	LeaveCriticalSection(&ic->clip_lock);
}

static BOOL iruka_pre_connect(freerdp* instance)
{
	rdpContext* context = instance->context;
	/* Hook channels such as RDPGFX up to gdi when they connect (using FreeRDP's common handlers)
	 *
	 * Known Issue (KNOWN_ISSUES.md, "FreeRDP allocates decode buffers it never uses"):
	 * once RDPGFX is hooked up to gdi here, every time the server resets the graphics
	 * FreeRDP's gdi_ResetGraphics (libfreerdp/gdi/gfx.c) recreates two full sets of
	 * decode buffers at desktop size: one for RDPGFX (used) and one in context->codecs
	 * for legacy screen updates (unused while RDPGFX is active). The Planar codec of the
	 * latter alone wastes about 18 bytes per pixel (about 35MB at 1080p, about 150MB at 4K).
	 * This is a FreeRDP-side problem, so no workaround is attempted here.
	 */
	if (PubSub_SubscribeChannelConnected(context->pubSub,
	                                     freerdp_client_OnChannelConnectedEventHandler) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub,
	                                        freerdp_client_OnChannelDisconnectedEventHandler) < 0)
		return FALSE;
	/* The clipboard channel is wired to the local clipboard by Iruka itself */
	if (PubSub_SubscribeChannelConnected(context->pubSub, iruka_on_channel_connected) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub, iruka_on_channel_disconnected) < 0)
		return FALSE;
	return TRUE;
}

static BOOL iruka_post_connect(freerdp* instance)
{
	/* Byte order R,G,B,X (same layout as RGBA on the Rust / Canvas side) */
	if (!gdi_init(instance, PIXEL_FORMAT_RGBX32))
		return FALSE;
	rdpUpdate* update = instance->context->update;
	update->BeginPaint = iruka_begin_paint;
	update->EndPaint = iruka_end_paint;
	update->DesktopResize = iruka_desktop_resize;
	/* Cursor shapes (gdi_init registers bitmaps and glyphs, the pointer class is the client's) */
	rdpPointer pointer = { 0 };
	pointer.size = sizeof(IrukaPointer);
	pointer.New = iruka_pointer_new;
	pointer.Free = iruka_pointer_free;
	pointer.Set = iruka_pointer_set;
	pointer.SetNull = iruka_pointer_set_null;
	pointer.SetDefault = iruka_pointer_set_default;
	pointer.SetPosition = iruka_pointer_set_position;
	graphics_register_pointer(instance->context->graphics, &pointer);
	return TRUE;
}

static void iruka_post_disconnect(freerdp* instance)
{
	if (!instance || !instance->context)
		return;
	PubSub_UnsubscribeChannelConnected(instance->context->pubSub,
	                                   freerdp_client_OnChannelConnectedEventHandler);
	PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub,
	                                      freerdp_client_OnChannelDisconnectedEventHandler);
	PubSub_UnsubscribeChannelConnected(instance->context->pubSub, iruka_on_channel_connected);
	PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub, iruka_on_channel_disconnected);
	gdi_free(instance);
}

static BOOL iruka_client_new(freerdp* instance, rdpContext* context)
{
	IrukaContext* ic = (IrukaContext*)context;
	if (!InitializeCriticalSectionAndSpinCount(&ic->clip_lock, 4000))
		return FALSE;
	ic->next_cursor_id = CURSOR_HIDDEN + 1;
	instance->PreConnect = iruka_pre_connect;
	instance->PostConnect = iruka_post_connect;
	instance->PostDisconnect = iruka_post_disconnect;
	return TRUE;
}

static void iruka_client_free(freerdp* instance, rdpContext* context)
{
	WINPR_UNUSED(instance);
	IrukaContext* ic = (IrukaContext*)context;
	free_cursor_images(ic);
	free(ic->local_text);
	free(ic->remote_text);
	DeleteCriticalSection(&ic->clip_lock);
}

/*
 * Create a session. Settings are passed in FreeRDP's command-line syntax (/v: /u: /gfx etc.).
 * This gives the same defaults as xfreerdp / sdl-freerdp, which is reassuring for compatibility.
 */
rdpContext* iruka_rdp_new(int argc, char** argv)
{
	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	entry.Version = RDP_CLIENT_INTERFACE_VERSION;
	entry.Size = sizeof(RDP_CLIENT_ENTRY_POINTS_V1);
	entry.ContextSize = sizeof(IrukaContext);
	entry.ClientNew = iruka_client_new;
	entry.ClientFree = iruka_client_free;

	rdpContext* context = freerdp_client_context_new(&entry);
	if (!context)
		return NULL;
	if (freerdp_client_settings_parse_command_line(context->settings, argc, argv, FALSE) != 0)
	{
		freerdp_client_context_free(context);
		return NULL;
	}
	/*
	 * Process dynamic channels (RDPGFX etc.) on the same thread as event processing (iruka_rdp_poll).
	 *
	 * By default drdynvc has its own thread, and both RDPGFX painting (gdi_OutputUpdate -> EndPaint)
	 * and the server's graphics reset (gdi_ResetGraphics -> DesktopResize -> gdi_resize) run on it.
	 * gdi_resize frees and reallocates primary_buffer, so if it happens while the Rust side is
	 * copying primary_buffer on another thread (around 150ms for a full 4K frame), freed memory
	 * gets read and the process crashes (2026-10-13: segfault in libc's memcpy right after the
	 * second 4K session connected). The dirty list races for the same reason.
	 * With synchronous channels, the only thread that touches gdi is the one calling iruka_rdp_poll.
	 */
	if (!freerdp_settings_set_bool(context->settings, FreeRDP_SynchronousDynamicChannels, TRUE))
	{
		freerdp_client_context_free(context);
		return NULL;
	}
	return context;
}

/* Connect and authenticate (may take a few seconds) */
int iruka_rdp_connect(rdpContext* context)
{
	if (freerdp_client_start(context) != 0)
		return 0;
	return freerdp_connect(context->instance) ? 1 : 0;
}

/* Wait up to timeout_ms for events and process them. 1: keep going, 0: disconnected, -1: error */
int iruka_rdp_poll(rdpContext* context, uint32_t timeout_ms)
{
	HANDLE handles[MAXIMUM_WAIT_OBJECTS] = { 0 };

	if (freerdp_shall_disconnect_context(context))
		return 0;
	DWORD count = freerdp_get_event_handles(context, handles, ARRAYSIZE(handles));
	if (count == 0)
		return -1;
	DWORD status = WaitForMultipleObjects(count, handles, FALSE, timeout_ms);
	if (status == WAIT_FAILED)
		return -1;
	if (!freerdp_check_event_handles(context))
		return freerdp_get_last_error(context) == FREERDP_ERROR_SUCCESS ? 0 : -1;
	return freerdp_shall_disconnect_context(context) ? 0 : 1;
}

/* The framebuffer (RGBX, stride bytes per row). NULL before connecting */
const uint8_t* iruka_rdp_framebuffer(rdpContext* context, uint32_t* width, uint32_t* height,
                                     uint32_t* stride)
{
	rdpGdi* gdi = context->gdi;
	if (!gdi || !gdi->primary_buffer)
		return NULL;
	*width = gdi->width;
	*height = gdi->height;
	*stride = gdi->stride;
	return gdi->primary_buffer;
}

/*
 * Take the regions changed since the last call (clipped to the screen).
 * Writes up to max entries of x, y, w, h into out and returns the count.
 */
int iruka_rdp_take_dirty(rdpContext* context, uint32_t* out, int max)
{
	IrukaContext* ic = (IrukaContext*)context;
	rdpGdi* gdi = context->gdi;
	if (!gdi)
		return 0;
	if (ic->ndirty > max)
		collapse_dirty(ic);
	int count = 0;
	for (int i = 0; i < ic->ndirty && count < max; i++)
	{
		const DirtyRect* r = &ic->dirty[i];
		INT32 left = r->x < 0 ? 0 : r->x;
		INT32 top = r->y < 0 ? 0 : r->y;
		INT32 right = r->x + r->w > gdi->width ? gdi->width : r->x + r->w;
		INT32 bottom = r->y + r->h > gdi->height ? gdi->height : r->y + r->h;
		if (right <= left || bottom <= top)
			continue;
		out[count * 4 + 0] = (uint32_t)left;
		out[count * 4 + 1] = (uint32_t)top;
		out[count * 4 + 2] = (uint32_t)(right - left);
		out[count * 4 + 3] = (uint32_t)(bottom - top);
		count++;
	}
	ic->ndirty = 0;
	return count;
}

void iruka_rdp_send_mouse(rdpContext* context, uint16_t flags, uint16_t x, uint16_t y)
{
	freerdp_input_send_mouse_event(context->input, flags, x, y);
}

void iruka_rdp_send_extended_mouse(rdpContext* context, uint16_t flags, uint16_t x, uint16_t y)
{
	freerdp_input_send_extended_mouse_event(context->input, flags, x, y);
}

/* scancode is PC/AT Set 1; extended keys are 0xE0xx */
void iruka_rdp_send_key(rdpContext* context, uint16_t scancode, int down)
{
	const BOOL extended = (scancode & 0xFF00) == 0xE000;
	const DWORD rdp_scancode = MAKE_RDP_SCANCODE(scancode & 0xFF, extended);
	freerdp_input_send_keyboard_event_ex(context->input, down ? TRUE : FALSE, FALSE, rdp_scancode);
}

/* Set the local clipboard text (UTF-8, NULL means empty) and announce it to the server */
void iruka_rdp_set_local_text(rdpContext* context, const char* text)
{
	IrukaContext* ic = (IrukaContext*)context;
	EnterCriticalSection(&ic->clip_lock);
	free(ic->local_text);
	ic->local_text = text ? _strdup(text) : NULL;
	LeaveCriticalSection(&ic->clip_lock);
	clip_send_format_list(ic);
}

/* Take the text copied on the remote side (NULL if none). Release it with iruka_rdp_free_text */
char* iruka_rdp_take_remote_text(rdpContext* context)
{
	IrukaContext* ic = (IrukaContext*)context;
	EnterCriticalSection(&ic->clip_lock);
	char* text = ic->remote_text;
	ic->remote_text = NULL;
	LeaveCriticalSection(&ic->clip_lock);
	return text;
}

void iruka_rdp_free_text(char* text)
{
	free(text);
}

/*
 * Take the oldest cursor shape not yet taken (NULL if none): its id, size and hotspot, and
 * width * height * 4 bytes of RGBA. Release the pixels with iruka_rdp_free_cursor_image.
 */
uint8_t* iruka_rdp_take_cursor_image(rdpContext* context, uint32_t* id, uint32_t* width,
                                     uint32_t* height, uint32_t* hot_x, uint32_t* hot_y)
{
	IrukaContext* ic = (IrukaContext*)context;
	CursorImage* img = ic->cursor_images;
	if (!img)
		return NULL;
	ic->cursor_images = img->next;
	*id = img->id;
	*width = img->width;
	*height = img->height;
	*hot_x = img->hot_x;
	*hot_y = img->hot_y;
	uint8_t* rgba = img->rgba;
	free(img);
	return rgba;
}

void iruka_rdp_free_cursor_image(uint8_t* rgba)
{
	free(rgba);
}

/*
 * The cursor the server wants shown, if it changed since the last call (returns 1 then).
 * 0 is the local default arrow, 1 means hidden, anything else is an id from
 * iruka_rdp_take_cursor_image (images are always queued before their id is selected).
 */
int iruka_rdp_take_cursor(rdpContext* context, uint32_t* id)
{
	IrukaContext* ic = (IrukaContext*)context;
	if (!ic->cursor_changed)
		return 0;
	ic->cursor_changed = FALSE;
	*id = ic->cursor_id;
	return 1;
}

/* Description of the most recent error (in English) */
const char* iruka_rdp_last_error(rdpContext* context)
{
	return freerdp_get_last_error_string(freerdp_get_last_error(context));
}

void iruka_rdp_disconnect(rdpContext* context)
{
	freerdp_disconnect(context->instance);
	freerdp_client_stop(context);
}

void iruka_rdp_free(rdpContext* context)
{
	freerdp_client_context_free(context);
}
