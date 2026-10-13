/*
 * Iruka ⇔ FreeRDP 3 の薄い橋渡し。
 *
 * FreeRDP 公式の画面なしサンプル（client/Sample/tf_freerdp.c）と同じ構成で、
 * GUI ツールキットを使わずに gdi（ソフトウェア描画）のフレームバッファを使う。
 * RDPGFX（Progressive / RemoteFX / H.264）の画面も gdi が primary_buffer に
 * 合成してくれるので、Rust 側は変化した矩形とフレームバッファだけを読めばよい。
 *
 * すべての関数は、そのセッションを担当する 1 本のスレッドから呼ぶこと。
 * ただしクリップボード（cliprdr）の通知は FreeRDP のチャネル用スレッドから来るので、
 * その受け渡しだけはロックで守る。
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
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/input.h>
#include <freerdp/scancode.h>
#include <winpr/string.h>
#include <winpr/user.h>

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

	/* クリップボード（テキストのみ）。clip_lock で守る */
	CRITICAL_SECTION clip_lock;
	CliprdrClientContext* cliprdr;
	BOOL clip_ready;   /* サーバーの Monitor Ready を受けた */
	char* local_text;  /* ローカルのテキスト（UTF-8）。サーバーに求められたら渡す */
	char* remote_text; /* リモートでコピーされたテキスト（UTF-8）。Rust が取りに来るまで持つ */
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

/* ---- クリップボード（cliprdr、テキストのみ） ----
 *
 * リモート → ローカル: サーバーがコピーを通知（Format List）→ テキストがあれば要求
 *   → 届いたら remote_text に置く → Rust が iruka_rdp_take_remote_text() で取り出す。
 * ローカル → リモート: Rust が iruka_rdp_set_local_text() で渡す → サーバーに通知
 *   → 貼り付け時にサーバーが要求してきたら local_text を返す。
 */

static IrukaContext* clip_owner(CliprdrClientContext* cliprdr)
{
	return (IrukaContext*)cliprdr->custom;
}

/* 今の local_text に合わせて、こちらにあるデータの種類をサーバーに通知する */
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

/* リモートでコピーされた：テキストがあれば中身を要求する */
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

/* 要求したテキストが届いた（UTF-16LE、終端の NUL を含むことがある） */
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

/* リモートで貼り付けられた：ローカルのテキストを渡す */
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
		/* 終端の NUL も含めて送る */
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
	/* RDPGFX などのチャネル接続時に gdi へつなぐ（FreeRDP 共通のハンドラを使う）
	 *
	 * Known Issue（KNOWN_ISSUES.md「FreeRDP が使わない展開用バッファーを確保する」）:
	 * ここで RDPGFX が gdi につながると、サーバーが画面を初期化するたびに
	 * FreeRDP の gdi_ResetGraphics（libfreerdp/gdi/gfx.c）が、展開用バッファー一式を
	 * 画面サイズで 2 組作り直す。RDPGFX 用（使う）と、旧方式の画面更新用の
	 * context->codecs（RDPGFX 中は使われない）。後者の Planar だけで約 18 バイト/画素
	 * （1080p で約 35MB、4K で約 150MB）が無駄になる。FreeRDP 側の問題なので回避はしない。
	 */
	if (PubSub_SubscribeChannelConnected(context->pubSub,
	                                     freerdp_client_OnChannelConnectedEventHandler) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub,
	                                        freerdp_client_OnChannelDisconnectedEventHandler) < 0)
		return FALSE;
	/* クリップボードのチャネルは Iruka 自身がローカルとつなぐ */
	if (PubSub_SubscribeChannelConnected(context->pubSub, iruka_on_channel_connected) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub, iruka_on_channel_disconnected) < 0)
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
	PubSub_UnsubscribeChannelConnected(instance->context->pubSub, iruka_on_channel_connected);
	PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub, iruka_on_channel_disconnected);
	gdi_free(instance);
}

static BOOL iruka_client_new(freerdp* instance, rdpContext* context)
{
	IrukaContext* ic = (IrukaContext*)context;
	if (!InitializeCriticalSectionAndSpinCount(&ic->clip_lock, 4000))
		return FALSE;
	instance->PreConnect = iruka_pre_connect;
	instance->PostConnect = iruka_post_connect;
	instance->PostDisconnect = iruka_post_disconnect;
	return TRUE;
}

static void iruka_client_free(freerdp* instance, rdpContext* context)
{
	WINPR_UNUSED(instance);
	IrukaContext* ic = (IrukaContext*)context;
	free(ic->local_text);
	free(ic->remote_text);
	DeleteCriticalSection(&ic->clip_lock);
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
	 * 動的チャネル（RDPGFX など）を、イベント処理（iruka_rdp_poll）と同じスレッドで処理する。
	 *
	 * 既定では drdynvc が自分のスレッドを持ち、RDPGFX の描画（gdi_OutputUpdate → EndPaint）と
	 * サーバーの画面リセット（gdi_ResetGraphics → DesktopResize → gdi_resize）がそのスレッドで
	 * 走る。gdi_resize は primary_buffer を解放して作り直すので、Rust 側が別スレッドで
	 * primary_buffer をコピーしている最中（4K のフルフレームで 150ms 前後）に起きると、
	 * 解放済みのメモリを読んで落ちる（2026-10-13、2 本目の 4K セッション接続直後に
	 * libc の memcpy で segfault）。dirty の一覧も同じ理由で競合する。
	 * 同期にすれば、gdi に触るのはすべて iruka_rdp_poll を呼ぶスレッドだけになる。
	 */
	if (!freerdp_settings_set_bool(context->settings, FreeRDP_SynchronousDynamicChannels, TRUE))
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

/* ローカルのクリップボードのテキスト（UTF-8、NULL なら空）を設定し、サーバーに通知する */
void iruka_rdp_set_local_text(rdpContext* context, const char* text)
{
	IrukaContext* ic = (IrukaContext*)context;
	EnterCriticalSection(&ic->clip_lock);
	free(ic->local_text);
	ic->local_text = text ? _strdup(text) : NULL;
	LeaveCriticalSection(&ic->clip_lock);
	clip_send_format_list(ic);
}

/* リモートでコピーされたテキストを取り出す（なければ NULL）。iruka_rdp_free_text で解放する */
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
