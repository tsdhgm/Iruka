*English: [KNOWN_ISSUES.md](KNOWN_ISSUES.md)*

# Known Issues

既知の不具合と制限事項。原因が Iruka の外（FreeRDP や OS）にあるものは、回避せずにここへ記録する。

## Win キーや Alt+Tab、Print Screen がリモートに届かない

- **状態**: 未対応（2026-10-09 に Known Bug として保留）
- **症状**: Win キー、Win+Space、Alt+Tab などが、リモートではなくローカルのデスクトップで処理される。Windows と Ubuntu（GNOME Remote Desktop）のどちらに接続していても同じ。
  Print Screen（Alt+Print、Shift+Print も）も同じで、GNOME がスクリーンショット UI のために取るので、キーでリモートの画面を撮れない（2026-10-24 に気づいた）。Iruka の変換表には `PrintScreen` が入っている。2026-10-24 からツールバーに Print Screen ボタン（⎙）があり、代わりにリモートでキーを押す（キーボードの独占はローカルのデスクトップに副作用があるので、作者はボタンを選んだ）。Ctrl+Print はローカルに取られずリモートに届き、Windows はこれを Print と同じに扱う。
  作者の運用（2026-10-24）: ボタンはたまに撮るときのもので、マニュアル用など連続して撮るときは Remmina（キーボードの独占）か、その PC の実機で行う。
- **原因**: ローカルの GNOME が、システムのショートカットとして先にキーを取ってしまう。FreeRDP の制限ではない。Remmina や mstsc は、キーボードを独占する仕組みでこれを避けている。
- **対応するなら**:
  - Linux：GTK のキーボードの独占、または Wayland の keyboard-shortcuts-inhibit プロトコル（GTK 3 の Wayland バックエンドが実装している。GNOME は初回にユーザーに確認し、Super+Esc でショートカットを戻せる）。
  - **Print Screen のコードを変えない回避策**: GNOME のスクリーンショットのショートカットを別のキーに移すと、Print がリモートに届く: `gsettings set org.gnome.shell.keybindings show-screenshot-ui "['<Ctrl>Print']"`、同様に `screenshot-window`（`<Alt>Print` → `<Ctrl><Alt>Print`）と `screenshot`（`<Shift>Print` → `<Ctrl><Shift>Print`）。`gsettings reset` で戻る。Win キーにはこの手の回避策はない（Win+Shift+S も Win が要る）。
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

## Windows: スマート アプリ コントロールが手元でビルドした / 署名のない iruka.exe を止める

- **状態**: 2026-10-26、新しく入れた Windows 11 Pro（ビルド 26200）で発見。開発用 PC ではスマート アプリ コントロールをオフにして回避。Iruka のバグではないが、署名のないビルドすべてに関わる。
- **症状**: `tauri dev` のビルドは通るが、`cargo run` が `could not execute process target\debug\iruka.exe (never executed)` / `An Application Control policy has blocked this file. (os error 4551)` で止まる。エクスプローラーから起動すると「スマート アプリ コントロールによってこのアプリの一部がブロックされました」と出る。
- **原因**: スマート アプリ コントロール（Windows セキュリティ → アプリとブラウザーの制御）は、Windows 11 をクリーンインストールすると多くの PC でオンになる。信頼された証明書で署名されたコードか、Microsoft のクラウドの評判サービスが知っているコードしか実行しない。ビルドしたばかりの `iruka.exe` はどちらでもない。ファイルやフォルダー単位の例外はなく、自己署名の証明書も信頼されない。（SmartScreen とは別物。SmartScreen はダウンロードしたファイルに警告するだけで、「実行」で通せる。）
- **対処**: 開発では、スマート アプリ コントロールをオフにする（設定 → プライバシーとセキュリティ → Windows セキュリティ → アプリとブラウザーの制御 → スマート アプリ コントロールの設定 → オフ）。以前はいったんオフにすると Windows を入れ直さない限りオンに戻せなかった。新しいビルドでは戻せるという話もあるが未確認。配布では、スマート アプリ コントロールがオンの利用者は署名のないポータブル zip も実行できない。避けられるのは信頼された証明書でのコード署名だけ（TODO_JA.md の Windows インストーラー）。

## Linux: 起動中にもう一度 Iruka を起動すると、動いている Iruka が死ぬ

- **状態**: 2026-10-24 に発見（起動口のテスト中の事故で）。未修正、修正候補は TODO_JA.md。Iruka 側の問題。
- **症状**: Iruka が動いているときにもう一度起動する（ドックのクリック、端末で `iruka`）と、二つ目はすぐステータス 0 で終わり、*動いていた*方がステータス 101 で終わる。標準エラーに `thread 'main' panicked at tauri-2.11.5/src/app.rs:1425: Failed to setup app: a webview with label 'main' already exists`。開いていたセッションは失われる。
- **原因**: tauri.conf.json の `enableGTKAppId: true` でプロセスは id `dev.tosihide.iruka` の `GtkApplication` になる。GApplication は二つ目のプロセスをリモートインスタンスとして扱い、`activate` を一つ目に転送して終了する。一つ目のイベントループ（tao）が二度目の `Ready` を報告し、Tauri が `setup` をもう一度実行して `main` 窓を作ろうとするが、すでにあるのでエラー、それがパニックになる。
- **修正候補**: (1) `tauri-plugin-single-instance` を入れ、二度目の起動は既存の窓を前面に出すだけにする。(2) `enableGTKAppId: false` にする。すると二度目の起動は独立した二つ目の Iruka になる（ドックが窓を見つけられるかは要確認: Wayland の app id はバイナリ名で、`StartupWMClass=iruka` で一致する）。
- 調べ方と記録: docs/linux-diagnostics_JA.md、docs/linux-diagnostics-log_JA.md。

## Linux: 高負荷時、たとえば OBS で画面キャプチャ中にアプリ全体が SIGKILL で消える

- **状態**: 2026-10-23 に原因を特定。作者の判断で記録のみ（回避策の候補は TODO_JA.md）。調査の経緯と質疑応答: docs/realtime-kill_JA.md。消えたときの一般的な調べ方: docs/linux-diagnostics_JA.md
- **症状**: 3840×2160 のセッションを複数開いているとき、特に OBS Studio が PipeWire で 4K ディスプレイをキャプチャしていると、Iruka が 1〜数分で消える。記録は何も残らない。クラッシュレポートなし、カーネルの OOM なし、Iruka・GTK・FreeRDP のメッセージもなし。gdb の下では `Program terminated with signal SIGKILL`。
- **原因**: WebKitGTK（WTF の `RealTimeThreads`。WebKitGTK 2.52.6 で確認）が RealtimeKit に頼んで IPC 受信スレッド（`ReceiveQueue`、UI プロセスに 2 本）を `SCHED_RR` 優先度 5 にし、`RLIMIT_RTTIME` を RealtimeKit の上限（ハード 200 ms、ソフト 160 ms）に設定する。カーネルは、リアルタイムスレッドがブロックせずに `RLIMIT_RTTIME` を超える CPU 時間を使ったプロセスを kill する。Iruka の IPC 量（4K セッション複数本のフレームが WebKit の IPC を通る）に OBS の CPU 競合が重なると、受信スレッドがブロックせずに 200 ms 以上走り、カーネルがプロセス全体に SIGKILL を送る。`signal_generate` の bpftrace で確認: `sig=9 to ReceiveQueue(...) from ReceiveQueue(同じプロセス) code=128`（SI_KERNEL）。WebKit はソフト上限で自分のスレッドを降格させる SIGXCPU ハンドラーを入れているが、トレースでは SIGKILL の前に SIGXCPU が出ておらず（カーネル 7.0、HZ=1000）、この保険は効かなかった。
- **確認方法**: `sudo bpftrace -e 'tracepoint:signal:signal_generate /args->sig == 9/ { printf("%s to %s(%d) from %s(%d) code=%d\n", strftime("%H:%M:%S", nsecs), args->comm, args->pid, comm, pid, args->code); }'` を動かして再現する。`ps -L -o tid,cls,rtprio,comm -p $(pgrep -x iruka)` で `RR` のスレッドが、`grep realtime /proc/$(pgrep -x iruka)/limits` で上限が見える。
- **コードを変えない回避策**（2026-10-23 に実使用で確認: OBS が 4K 画面をキャプチャしていても kill されない。ただし OBS が動いている間は Iruka の反応が目に見えて遅い。音声とクリップボードは未確認）: `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent` を付けて Iruka を起動する。WebKit が RealtimeKit に届かなくなり、スレッドは `SCHED_OTHER` のまま、上限も付かない。ドック用には `/usr/share/applications/Iruka.desktop` を `~/.local/share/applications/` に複製し、`Exec=env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent iruka` にする。詳細と注意点は docs/realtime-kill_JA.md。
- **直すなら**: 上限は上げられない（RealtimeKit が 200 ms で頭打ちにし、プロセスはハード上限を下げることしかできない）。選択肢: (1) Iruka が自分のプロセスの `ReceiveQueue` スレッドを `SCHED_OTHER` に戻す（`/proc/self/task` のうちポリシーが `SCHED_RR` のスレッドに `sched_setscheduler`。WebKit はビューが見えるようになると再び昇格させるので、既存のメモリ計測スレッドから繰り返す）。IPC の遅延がわずかに増えるが Iruka には不要な速さ。(2) SIGXCPU の保険が効かなかったことを WebKitGTK に報告する。(3) Iruka の IPC 量を減らす（フレームを減らす・小さくする）。これは閾値をずらすだけ。

## リモートの端末のスピナーは動画と同じだけの負荷になる

- **状態**: 2026-10-25 に判明。Iruka 側に直すものはなく、使い方の注意。
- **症状**: 「何もしていない」はずの Ubuntu のリモート（10.0.1.53、GNOME Remote Desktop）が、YouTube を再生している機より多くの画面データを送ってきた。毎秒約 10 フレーム、1 フレームが 3840×2160 の 4 分の 1（展開後 85 MB/s、回線上 0.9 MB/s）。小さいクライアント機では、これがフレームの待ち行列を埋める（docs/code-notes_JA.md の弱いところ (h)）。
- **原因**: そのリモートの端末ウィンドウで AI の CLI（grok）が動いていて、状態表示の行が毎秒何度も定位置で書き換わっていた。リモートデスクトップのサーバーは更新領域をウィンドウ単位に近い粒度で送るので、数文字の変化でも端末ウィンドウ全体のぶんが毎回かかる。スピナー、`top`、秒を刻む時計、ライブのダッシュボードも同じ（10.0.1.113 の時計付きダッシュボード: 0.2〜0.7 MB/s）。
- **確かめ方**: `ss -tin state established '( dport = :3389 )'` を 20 秒おきに 2 回取り、ホストごとの `bytes_received` を比べる。端末を置き換える（最小化する）と 10.0.1.53 は即座に 0 になった。
- **対処**: そういうウィンドウは最小化しておく（最小化したウィンドウは更新を生まない）か、表示していないワークスペースに置くか、そのセッションの解像度を下げる。Iruka はスピナーと動画を区別できない。将来のセッションごとのフレームレート上限（TODO_JA.md）は負荷を抑えるが無駄そのものは減らない。

## 約 9 秒の停滞で "The connection transport layer failed" とセッションが切れる

- **状態**: 2026-10-25 に判明、同日に緩和: タイムアウトを 60 秒に延ばし、9 秒以上の停滞を画面の上に出し、切れたセッションは自動で再接続する（README_JA.md「回線の状態と再接続」）。Wi-Fi の損失そのものは Iruka の外。
- **症状**: 常時描き変わるブラウザのページを全画面で表示する試験（背圧ビルドの 2 回目）の最中に、10.0.1.113 のセッションが "Connection error (FreeRDP): Communication error: The connection transport layer failed." で終わった。直後にそのホストには ping が通り、3389 番も開いていた。ほかの 5 本は生きていた。
- **原因**: FreeRDP はすべての接続に `TCP_USER_TIMEOUT` 9000 ms（`FreeRDP_TcpAckTimeout` の既定値）と TCP keep-alive（無通信 5 秒、間隔 2 秒、3 回）を設定する。クライアントが送ったデータ（フレームの応答、マウスの移動）にリモートからの ACK が 9 秒来ないと、カーネルがソケットを ETIMEDOUT で打ち切り、FreeRDP はこの一般的なトランスポートの誤りとして報告する。この機では RDP の通信はすべて Wi-Fi を通る（有線ポートは別のネットワーク）。起動からカーネルは TCP の再送 4568 回、再送タイムアウト 255 回、タイムアウトによる接続の打ち切り 1 回を数えていて（`nstat -az | grep -E 'TcpRetransSegs|TcpExtTCPTimeouts|TcpExtTCPAbortOnTimeout'`）、その 1 回がこのセッション。フレームの関門（`FrameGate`）が原因にはなりえない。FreeRDP のスレッドは関門を待たないし、FreeRDP 自身がサーバーに返すフレームの応答にも影響しない。
- **確かめ方**: 前後で `nstat -az` を取る。端末のエラーの直前の FreeRDP のログ行（`BIO_read returned a system error 110: Connection timed out` など）。同じ機の Remmina も同じ既定値なので同じように切れる。
- **対処**: リモート側のネットワークへの有線接続、または Wi-Fi 越しの 4K セッションを減らす（4K の全画面の描き変えは回線上でセッションあたり約 1 MB/s で、ひとまとまりの損失が応答を止める）。Iruka は `/timeout:60000` を渡し、自分で再接続するようになった。60 秒を超える停滞や、10 回の試み（1 分ほど）の間ずっと届かないリモートは、今もこのメッセージでセッションが終わる。

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
