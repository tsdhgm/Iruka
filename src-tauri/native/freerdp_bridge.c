/*
 * Iruka ⇔ FreeRDP 3 の薄い橋渡し。
 *
 * FreeRDP 公式の画面なしサンプル（client/Sample/tf_freerdp.c）と同じ構成で、
 * GUI ツールキットを使わずに gdi（ソフトウェア描画）のフレームバッファを使う。
 * RDPGFX（Progressive / RemoteFX / H.264）の画面も gdi が primary_buffer に
 * 合成してくれるので、Rust 側は変化した矩形とフレームバッファだけを読めばよい。
 *
 * すべての関数は、そのセッションを担当する 1 本のスレッドから呼ぶこと。
 */

#include <stdint.h>
#include <string.h>

#include <winpr/synch.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/channels/channels.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/input.h>
#include <freerdp/scancode.h>

/* ためておく変化範囲の上限。超えたら全体を 1 つの矩形にまとめる */
#define MAX_DIRTY 128

typedef struct
{
	INT32 x, y, w, h;
} DirtyRect;

typedef struct
{
	rdpClientContext common;

	/* 前回 iruka_rdp_take_dirty() 以降に変化した範囲の一覧 */
	DirtyRect dirty[MAX_DIRTY];
	int ndirty;
} IrukaContext;

/* ためた範囲を、全部を囲む 1 つの矩形にまとめる */
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
 * 1 フレーム分の合成が終わったときに呼ばれる。変化した範囲を記録する。
 * hwnd->invalid は全部を囲む 1 つの矩形なので、離れた 2 か所が変わると巨大になる。
 * 個々の範囲の一覧（cinvalid）を使い、読んだら件数を 0 に戻す（xfreerdp と同じ）。
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

/* サーバーが画面サイズを変えた（再アクティベーション、RDPGFX の ResetGraphics） */
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

static BOOL iruka_pre_connect(freerdp* instance)
{
	rdpContext* context = instance->context;
	/* RDPGFX などのチャネル接続時に gdi へつなぐ（FreeRDP 共通のハンドラを使う） */
	if (PubSub_SubscribeChannelConnected(context->pubSub,
	                                     freerdp_client_OnChannelConnectedEventHandler) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub,
	                                        freerdp_client_OnChannelDisconnectedEventHandler) < 0)
		return FALSE;
	return TRUE;
}

static BOOL iruka_post_connect(freerdp* instance)
{
	/* バイト順 R,G,B,X（Rust / Canvas の RGBA と同じ並び） */
	if (!gdi_init(instance, PIXEL_FORMAT_RGBX32))
		return FALSE;
	rdpUpdate* update = instance->context->update;
	update->BeginPaint = iruka_begin_paint;
	update->EndPaint = iruka_end_paint;
	update->DesktopResize = iruka_desktop_resize;
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
	gdi_free(instance);
}

static BOOL iruka_client_new(freerdp* instance, rdpContext* context)
{
	WINPR_UNUSED(context);
	instance->PreConnect = iruka_pre_connect;
	instance->PostConnect = iruka_post_connect;
	instance->PostDisconnect = iruka_post_disconnect;
	return TRUE;
}

/*
 * セッションを作る。設定は FreeRDP のコマンドライン形式（/v: /u: /gfx など）で渡す。
 * xfreerdp / sdl-freerdp と同じ既定値になるので、互換性の面で安心できる。
 */
rdpContext* iruka_rdp_new(int argc, char** argv)
{
	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	entry.Version = RDP_CLIENT_INTERFACE_VERSION;
	entry.Size = sizeof(RDP_CLIENT_ENTRY_POINTS_V1);
	entry.ContextSize = sizeof(IrukaContext);
	entry.ClientNew = iruka_client_new;

	rdpContext* context = freerdp_client_context_new(&entry);
	if (!context)
		return NULL;
	if (freerdp_client_settings_parse_command_line(context->settings, argc, argv, FALSE) != 0)
	{
		freerdp_client_context_free(context);
		return NULL;
	}
	return context;
}

/* 接続と認証（数秒かかることがある） */
int iruka_rdp_connect(rdpContext* context)
{
	if (freerdp_client_start(context) != 0)
		return 0;
	return freerdp_connect(context->instance) ? 1 : 0;
}

/* イベントを最大 timeout_ms 待って処理する。1: 継続, 0: 切断された, -1: エラー */
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

/* フレームバッファ（RGBX、1 行 stride バイト）。接続前は NULL */
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
 * 前回以降に変化した範囲を取り出す（画面内に切り詰める）。
 * out には x, y, w, h の順で最大 max 個書き込み、個数を返す。
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

/* scancode は PC/AT Set 1。拡張キーは 0xE0xx */
void iruka_rdp_send_key(rdpContext* context, uint16_t scancode, int down)
{
	const BOOL extended = (scancode & 0xFF00) == 0xE000;
	const DWORD rdp_scancode = MAKE_RDP_SCANCODE(scancode & 0xFF, extended);
	freerdp_input_send_keyboard_event_ex(context->input, down ? TRUE : FALSE, FALSE, rdp_scancode);
}

/* 直近のエラーの説明（英語） */
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
