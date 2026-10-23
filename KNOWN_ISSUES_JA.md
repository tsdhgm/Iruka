*English: [KNOWN_ISSUES.md](KNOWN_ISSUES.md)*

# Known Issues

既知の不具合と制限事項。原因が Iruka の外（FreeRDP や OS）にあるものは、回避せずにここへ記録する。

## Win キーや Alt+Tab がリモートに届かない

- **状態**: 未対応（2026-10-09 に Known Bug として保留）
- **症状**: Win キー、Win+Space、Alt+Tab などが、リモートではなくローカルのデスクトップで処理される。Windows と Ubuntu（GNOME Remote Desktop）のどちらに接続していても同じ。
- **原因**: ローカルの GNOME が、システムのショートカットとして先にキーを取ってしまう。FreeRDP の制限ではない。Remmina や mstsc は、キーボードを独占する仕組みでこれを避けている。
- **対応するなら**:
  - Linux：GTK のキーボードの独占、または Wayland の keyboard-shortcuts-inhibit プロトコル。
  - Windows：低レベルキーボードフック（`WH_KEYBOARD_LL`）。mstsc と同じ方式。

## Mac（macrdp）で Option+V のペーストが効かない

- **状態**: 保留（2026-10-13）
- **症状**: clintcan/macrdp を入れた Mac に接続したとき、Option+V でペーストできない。クリップボードの共有そのものは双方向で動いていて、別の操作（メニューからのペーストなど）では貼り付けられる。
- **原因**: 未調査。Iruka は Alt を RDP のスキャンコード（左 Alt = 0x38）で送っており、Mac 側で Option / Command のどちらに割り当てるかは macrdp の変換しだい。Iruka の右 Alt は一覧表示の切り替えに使っているので、右 Alt 単独ではなく、左 Alt で試すこと（README の「表示切り替えキー」参照）。
- **対応するなら**: macrdp のキー変換（Cmd キーのショートカット再現）の設定を確認する。Iruka 側は変更不要の見込み。

## クリップボードはテキストのみ

- **状態**: 制限事項（2026-10-09）
- **内容**: 共有できるのはテキストだけ。画像とファイルのコピー＆ペーストはできない。IronRDP で接続したときは、テキストも共有できない。
- **理由**: 監視用途ではテキストで十分と判断した。画像は追加の手間が小さいので、必要になれば対応できる。ファイルはファイルの中身を少しずつ転送する仕組み（cliprdr の FileContents）が別に必要で、手間が大きい。
- **関連**: 同期するのは表示中のセッションだけ（README の「クリップボード」参照）。これは仕様で、裏のセッションでのコピーがローカルのクリップボードを上書きしないようにしている。

## Windows: vcpkg の OpenSSL が legacy プロバイダーを見つけられない（NTLM）

- **状態**: 環境変数で回避。`OPENSSL_MODULES` を設定すると警告は消え、Windows の接続先に NLA（NTLM）でつながる（2026-10-16）
- **症状**: 接続時に FreeRDP が `[SSL] {Digest} build or configuration missing: md4: NTLM support not available` と `rc4: … NTLM and autoreconnect cookies will not work` を出す。GNOME Remote Desktop にはつながる。NLA で NTLM を使う Windows の接続先には失敗する見込み。
- **原因**: OpenSSL 3 では MD4 と RC4 は「legacy」プロバイダー（`legacy.dll`）にある。vcpkg の `libcrypto-3-x64.dll` は `MODULESDIR` = `C:\Program Files\OpenSSL\bin` でビルドされていて、そこを探す。`legacy.dll` が実際にある vcpkg の `bin` は見ない。
- **対処**: Iruka の起動前に、`OPENSSL_MODULES` を `legacy.dll` のあるフォルダー（vcpkg の `installed\x64-windows\bin`）にする。インストーラーでは `legacy.dll` を `iruka.exe` の横に同梱し、変数が未設定なら Iruka が起動時に自分のフォルダーを `OPENSSL_MODULES` に設定する。

## Linux: 高負荷時、たとえば OBS で画面キャプチャ中にアプリ全体が SIGKILL で消える

- **状態**: 2026-10-23 に原因を特定。作者の判断で記録のみ（回避策の候補は TODO_JA.md）。調査の経緯と質疑応答: docs/realtime-kill_JA.md
- **症状**: 3840×2160 のセッションを複数開いているとき、特に OBS Studio が PipeWire で 4K ディスプレイをキャプチャしていると、Iruka が 1〜数分で消える。記録は何も残らない。クラッシュレポートなし、カーネルの OOM なし、Iruka・GTK・FreeRDP のメッセージもなし。gdb の下では `Program terminated with signal SIGKILL`。
- **原因**: WebKitGTK（WTF の `RealTimeThreads`。WebKitGTK 2.52.6 で確認）が RealtimeKit に頼んで IPC 受信スレッド（`ReceiveQueue`、UI プロセスに 2 本）を `SCHED_RR` 優先度 5 にし、`RLIMIT_RTTIME` を RealtimeKit の上限（ハード 200 ms、ソフト 160 ms）に設定する。カーネルは、リアルタイムスレッドがブロックせずに `RLIMIT_RTTIME` を超える CPU 時間を使ったプロセスを kill する。Iruka の IPC 量（4K セッション複数本のフレームが WebKit の IPC を通る）に OBS の CPU 競合が重なると、受信スレッドがブロックせずに 200 ms 以上走り、カーネルがプロセス全体に SIGKILL を送る。`signal_generate` の bpftrace で確認: `sig=9 to ReceiveQueue(...) from ReceiveQueue(同じプロセス) code=128`（SI_KERNEL）。WebKit はソフト上限で自分のスレッドを降格させる SIGXCPU ハンドラーを入れているが、トレースでは SIGKILL の前に SIGXCPU が出ておらず（カーネル 7.0、HZ=1000）、この保険は効かなかった。
- **確認方法**: `sudo bpftrace -e 'tracepoint:signal:signal_generate /args->sig == 9/ { printf("%s to %s(%d) from %s(%d) code=%d\n", strftime("%H:%M:%S", nsecs), args->comm, args->pid, comm, pid, args->code); }'` を動かして再現する。`ps -L -o tid,cls,rtprio,comm -p $(pgrep -x iruka)` で `RR` のスレッドが、`grep realtime /proc/$(pgrep -x iruka)/limits` で上限が見える。
- **コードを変えない回避策**（2026-10-23 に起動だけ確認）: `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent` を付けて Iruka を起動する。WebKit が RealtimeKit に届かなくなり、スレッドは `SCHED_OTHER` のまま、上限も付かない。ドック用には `/usr/share/applications/Iruka.desktop` を `~/.local/share/applications/` に複製し、`Exec=env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent iruka` にする。詳細と注意点は docs/realtime-kill_JA.md。
- **直すなら**: 上限は上げられない（RealtimeKit が 200 ms で頭打ちにし、プロセスはハード上限を下げることしかできない）。選択肢: (1) Iruka が自分のプロセスの `ReceiveQueue` スレッドを `SCHED_OTHER` に戻す（`/proc/self/task` のうちポリシーが `SCHED_RR` のスレッドに `sched_setscheduler`。WebKit はビューが見えるようになると再び昇格させるので、既存のメモリ計測スレッドから繰り返す）。IPC の遅延がわずかに増えるが Iruka には不要な速さ。(2) SIGXCPU の保険が効かなかったことを WebKitGTK に報告する。(3) Iruka の IPC 量を減らす（フレームを減らす・小さくする）。これは閾値をずらすだけ。

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
