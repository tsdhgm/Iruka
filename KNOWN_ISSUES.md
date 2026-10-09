# Known Issues

既知の不具合と制限事項。原因が Iruka の外（FreeRDP や OS）にあるものは、回避せずにここへ記録する。

## Win キーがリモートに届かない

- **状態**: 未対応（2026-10-09 に Known Bug として保留）
- **症状**: Win キーや Win+Space が、リモートではなくローカルのデスクトップで処理される。Windows と Ubuntu（GNOME Remote Desktop）のどちらに接続していても同じ。
- **原因**: ローカルの GNOME が、システムのショートカットとして先にキーを取ってしまう。FreeRDP の制限ではない。Remmina や mstsc は、キーボードを独占する仕組みでこれを避けている。
- **対応するなら**:
  - Linux：GTK のキーボードの独占、または Wayland の keyboard-shortcuts-inhibit プロトコル。
  - Windows：低レベルキーボードフック（`WH_KEYBOARD_LL`）。mstsc と同じ方式。

## FreeRDP が使わない展開用バッファーを確保する

- **状態**: FreeRDP 側の問題として保留（2026-10-09）
- **症状**: RDP セッション 1 本あたり、1 ピクセルにつき約 18 バイトのメモリが無駄になる。1920×1080 で約 35MB、3840×2160 で約 150MB。
- **原因**: FreeRDP 3.32.1 の `gdi_ResetGraphics`（`libfreerdp/gdi/gfx.c`）は、サーバーが画面を初期化するたびに、展開用バッファー一式（Planar、Progressive、ClearCodec など）を画面サイズで **2 組** 作り直す。
  - RDPGFX 用の 1 組（描画に使う）
  - 旧方式の画面更新用の `context->codecs`（RDPGFX でつないでいる間は使われない）

  後者の Planar 用バッファーだけで、約 18 バイト/画素になる。
- **引き金になる Iruka 側のコード**:
  - `src-tauri/src/rdp/freerdp.rs` の `/gfx` 指定
  - `src-tauri/native/freerdp_bridge.c` の `iruka_pre_connect`（RDPGFX を gdi につなぐ処理）
- **Iruka 側で回避するなら**: `ResetGraphics` を包み、元の処理の後で `context->codecs` を解放して最小サイズで作り直す（下の「参考：回避策のコード」）。
  - FreeRDP の `winpr_aligned_offset_recalloc` は縮める方向ではメモリを返さないので、小さいサイズで reset し直すだけでは減らない。
  - サーバーが旧方式で画面を送ってくると展開に失敗し、切断されうる。
  - 別スレッドで使用中のバッファーを解放する危険がある。

  以上の理由で、回避策は採らない。
- **今後**: Windows 版などで FreeRDP を自前でビルドする段階で、FreeRDP 本体を直すことを検討する（使うときに初めて確保する形にする、または上流に修正を提案する）。

### 参考：回避策のコード

説明用のコード（Iruka には適用していない）。`freerdp_bridge.c` に入れる想定。

```c
/* gdi が設定する ResetGraphics を包む（サーバーの画面初期化のたびに呼ばれる） */
static pcRdpgfxResetGraphics gdi_reset_graphics; /* 元の gdi_ResetGraphics */

static UINT iruka_reset_graphics(RdpgfxClientContext* gfx, const RDPGFX_RESET_GRAPHICS_PDU* pdu)
{
	/* gdi はここで、RDPGFX 用と旧方式用の 2 組を画面サイズで作り直す */
	UINT rc = gdi_reset_graphics(gfx, pdu);
	if (rc != CHANNEL_RC_OK)
		return rc;

	/* 旧方式用（RDPGFX 中は使われない）を解放し、最小サイズで作り直す。
	 * 縮める方向の reset では FreeRDP がメモリを返さないため、作り直しが必要 */
	rdpGdi* gdi = (rdpGdi*)gfx->custom;
	rdpContext* context = gdi->context;
	rdpSettings* settings = context->settings;
	rdpCodecs* small = freerdp_client_codecs_new(
	    freerdp_settings_get_uint32(settings, FreeRDP_ThreadingFlags));
	if (!small || !freerdp_client_codecs_prepare(small,
	                  freerdp_settings_get_codecs_flags(settings), 64, 64))
	{
		freerdp_client_codecs_free(small);
		return CHANNEL_RC_OK; /* 失敗したら元のまま使う */
	}
	freerdp_client_codecs_free(context->codecs);
	context->codecs = small;
	return CHANNEL_RC_OK;
}

/* チャネル接続時：FreeRDP 共通の処理で gdi につないだ後、ResetGraphics を差し替える */
static void iruka_on_channel_connected(void* ctx, const ChannelConnectedEventArgs* e)
{
	freerdp_client_OnChannelConnectedEventHandler(ctx, e);
	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
	{
		RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
		/* チャネルのつなぎ直しで自分自身を保存すると、無限に自分を呼ぶ */
		if (gfx->ResetGraphics != iruka_reset_graphics)
		{
			gdi_reset_graphics = gfx->ResetGraphics;
			gfx->ResetGraphics = iruka_reset_graphics;
		}
	}
}
```

使う場合は、`iruka_pre_connect` で購読するハンドラーを `freerdp_client_OnChannelConnectedEventHandler` から `iruka_on_channel_connected` に変える（切断側の `freerdp_client_OnChannelDisconnectedEventHandler` はそのまま）。

### 参考：1920×1080 のセッション 1 本の内訳（heaptrack、2026-10-09）

| 何に使っているか | 量 |
|---|---|
| FreeRDP の Planar 方式の展開用バッファー（2 組分） | 約 71MB |
| FreeRDP の Progressive 方式の展開用バッファー | 約 42MB |
| FreeRDP のその他（ClearCodec、zgfx など） | 約 40MB |
| FreeRDP の描画用の画面バッファー | 約 8MB |
| WebView 側（canvas など） | 約 30〜45MB |
| Iruka 自身の画面データの受け渡し | ほぼ 0 |
