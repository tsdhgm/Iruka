*English: [code-notes.md](code-notes.md)*

# 設計メモと弱いところ

コードを読む人・変える人向けのメモ。部品どうしのつながり、Rust と C の境界で守るべき決まり、荒いとわかっている箇所を書く。ここの事実や数字は 2026-10-13 にソースと突き合わせた。コードとこの文書が食い違ったら、コードが正しい。

## 1. 構成の概要

Iruka は Tauri 2 のアプリ。WebView 上の React / TypeScript のフロントと、すべての接続を持つ Rust のバックエンド（`src-tauri`）からなる。ネットワークに関わる処理は WebView では一切行わない。

```
WebView (React)                      Rust (src-tauri)                        ネイティブ / ネットワーク
----------------------------------   -------------------------------------   -------------------------
App.tsx, src/components, hostKey.ts  lib.rs: Tauri コマンド、ログフィルター
                                     pty.rs: コンソール (portable-pty)  <----> ローカルのシェル
  RDP セッションごとの <canvas> <---  rdp/mod.rs: RdpState, FrameSink
  Channel<ArrayBuffer>（画面）          |-- rdp/freerdp.rs  --FFI-->  native/freerdp_bridge.c --> libfreerdp3
  Channel<RdpEvent>（resize/closed）    '-- rdp/ironrdp.rs  ---------> IronRDP クレート (rustls)  --> サーバー
                                     clipboard.rs: arboard + アクティブなセッション ID
                                     memory.rs: 使用量の記録 + 見積もりモデル
```

### Tauri コマンド

フロントが `invoke` で呼ぶコマンドは `lib.rs` で登録する。

- コンソール: `spawn_session`, `write_session`, `resize_session`, `kill_session`（`pty.rs`）
- RDP: `rdp_connect`, `rdp_input`, `rdp_close`, `rdp_set_active`, `rdp_is_self`, `rdp_perf_log`（`rdp/mod.rs`）
- メモリ: `rdp_memory_check`（`memory.rs`）

コンソールと RDP のセッション ID は 1 つの空間を共有する（`lib.rs` の `NEXT_SESSION_ID`、`AtomicU32`）。フロントが 1 つの一覧で扱うため。

### `RdpBackend` トレイト

`rdp/mod.rs` には RDP セッションに共通の部分（セッションの登録、画面の受け渡し、入力の型）を集め、プロトコルそのものはバックエンドに任せる。

```rust
pub trait RdpBackend: Sync {
    fn name(&self) -> &'static str;
    fn run(&self, params: &RdpConnectParams, commands: &Receiver<Command>, sink: &mut FrameSink)
        -> anyhow::Result<String>;
}
```

`rdp_connect` はバックエンドを選び（`select_backend`。Auto は `freerdp` フィーチャーがあれば FreeRDP を優先）、ID を割り当て、`Sender<Command>` を `RdpState` に登録し、**セッションごとに 1 本のスレッド**を起こして `run` を呼ぶ。`run` は `commands`（`Input`, `ClipboardLocal`, `Close`）を定期的に確認し、セッションが終わったら戻る。スレッドはそのあと登録を外し、`RdpEvent::Closed { reason, error, backend }` を送る。`Cargo.toml` では `freerdp` と `ironrdp` の両フィーチャーが既定で有効。`build.rs` が `native/freerdp_bridge.c` を `cc` でビルドし、pkg-config の `freerdp-client3` とリンクする。

**FreeRDP バックエンド**（`rdp/freerdp.rs` + `native/freerdp_bridge.c`）: Rust 側で FreeRDP のコマンドライン（`/v: /port: /u: /p: /size: /bpp:32 /gfx[:small-cache] /network:auto /cert:ignore`、ほかに `-clipboard`、`/sound` または `/audio-mode:2`、`/microphone`、`/d:`）を組み立てて `iruka_rdp_new` に渡すので、既定値は `xfreerdp` と同じになる。C の橋渡しは FreeRDP の画面なしサンプル（`client/Sample/tf_freerdp.c`）に倣った構成で、`gdi` を `PIXEL_FORMAT_RGBX32` で初期化し、`BeginPaint` / `EndPaint` / `DesktopResize` を差し替え、`EndPaint` が報告する無効領域を小さな変化矩形の一覧（最大 128 個。超えたら全体を囲む 1 つにまとめる）に記録する。RDPGFX（Progressive / RemoteFX / H.264）は `/gfx` で有効にする。GNOME Remote Desktop はグラフィックスパイプラインのないクライアントを拒むので、これが必須。Rust 側のループは、`commands` を捌く → `iruka_rdp_poll`（FreeRDP のイベントハンドルを最大 15 ms 待つ）→ リモートのクリップボードのテキストを回収 → フレームバッファと変化矩形を読む → `sink.flush`、の繰り返し。

**IronRDP バックエンド**（`rdp/ironrdp.rs`）: 純 Rust。`rustls` の TLS ストリームと CredSSP の上で `ironrdp-blocking` を使う。`DecodedImage`（RGBA）にデコードし、`GraphicsUpdate` の矩形を sink に渡す。Deactivation-Reactivation シーケンス（ログオン後の解像度変更）にも対応している。制限は弱いところ (e) を参照。

### `FrameSink` と画面データのバイナリ形式

`FrameSink` は、画面の受け渡しのバックエンド側の窓口。

- `damage(rect)` で変化した矩形をためる。`MAX_DIRTY_RECTS`（128）を超えたら全体を囲む 1 つにまとめる。
- `flush(fb, force)` は、`force` でなければ `FRAME_INTERVAL`（33 ms、約 30 fps）に 1 回までしか動かない。重なる・接する矩形をまとめ（`merge_rects`）、フレームバッファの範囲に切り詰め、各矩形の画素を `FrameView` から 1 つの `Vec<u8>` にコピーし（アルファは 0xff に固定）、キューに入れる。
- セッションごとに**別の送信スレッド**（`FrameSink::new` で起こす）が、`mpsc` チャネルからメッセージを取り出し、`Channel<InvokeResponseBody>::send(InvokeResponseBody::Raw(..))` で WebView に押し込む。セッションのスレッドは WebView を待たないので、入力の遅延は描画に左右されない。
- **背圧**: 共有の `busy: Arc<AtomicBool>` をキューに入れるときに立て、送信スレッドが `send` から戻ったら下ろす。立っている間は `flush` は何もせず、変化矩形がたまり続けるので、次の flush では溜まった分を順に送るのではなく、まとめた最新の 1 枚を送る。
- `resize(width, height)` は変化矩形を捨て、メモリモデルにサイズを記録し、`RdpEvent::Resize` を送る。フロントは canvas を新しいサイズで作り直し、バックエンドは画面全体を damage する。

画面データのメッセージはリトルエンディアンのバイナリ。

| オフセット | 内容 |
|---|---|
| 0 | フレームバッファの幅、`u32` |
| 4 | フレームバッファの高さ、`u32` |
| 8 | 矩形の数、`u32` |
| 12 | 予備、`u32`（0） |
| 16 | `sent_at`、`f64`、UNIX 時刻のミリ秒（遅延の計測用） |
| 24 | 矩形ごとに `x, y, w, h` の `u32` 4 つ、続けて `w*h*4` バイトの RGBA |

フロント（`src/rdpSession.ts`）は `DataView` で読み、フレームバッファのサイズが canvas と合わないメッセージ（サイズ変更をまたいだもの）は捨て、各矩形を `putImageData` で描く。サムネイルはセッションの canvas から描き直す（`src/rdp.ts` の `drawCanvasToCanvas`）。

### 画面の複製はフロントでは canvas だけ

WebView はリモートの画面をセッションの `<canvas>` にしか持っていない。バックエンドは変化した矩形だけを送り、自分からフルフレームを送ることはない。セッションが隠れている間（一覧表示中や、別のセッションが前面のとき）canvas は `display: none` で、WebKitGTK は大きな非表示の canvas の中身を捨てることがある。再表示すると黒く、リモートがたまたま全画素を描き直すまで黒いままになる（2026-10-15、4K のセッションで右 Alt の一覧切り替えの後に発生。同じ GNOME Remote Desktop に別のクライアントがつながるとサーバーが画面全体を送り直すので、それで「直った」ように見えた）。そのため `showSession` は、RDP セッションを前面に出すたびに `rdp_refresh` コマンドを呼ぶ。バックエンドは画面全体を dirty にして、自分の複製（FreeRDP の gdi バッファー、または IronRDP の `DecodedImage`）からフルフレームを 1 回送る。サーバーは関与しない。

### 入力

フロントは `KeyboardEvent.code` を `src/rdp.ts` の `SCANCODES` 表で PC/AT Set 1 のスキャンコードに変換する（拡張キーは `0xE0xx`）。配列はリモート側が決める。マウス座標は `toRemoteCoords` でリモートのピクセルに写す。イベントは `RdpInput`（`MouseMove`, `MouseButton`, `Wheel`, `Key`, `ReleaseAll`）としてまとめて `rdp_input` で送る。FreeRDP はキーの押下状態を管理しないので、フォーカスが外れたら `ReleaseAll` で修飾キーを離す。

### フロントの構成

`App.tsx` がセッションの状態を持ち、フォーム、一覧表示、ツールバー、モーダル、ホストキーの追跡は `src/components` と `src/hostKey.ts` にある。セッションごとの配線（RDP の画面データの復号、コンソールの xterm.js）は `src/rdpSession.ts` と `src/ptySession.ts`。ホストキーの追跡は「右 Alt 単独で一覧を切り替え、右 Alt + キーは普通の Alt」の規則を実現するもので、別のキーが続くかどうかわかるまで押下を保留する。

### PTY セッション（コンソール）

`pty.rs` は `portable-pty` を使う。`spawn_session` は指定のプログラム（なければ `$SHELL`、それもなければ `bash`）を `TERM=xterm-256color` でホームディレクトリから起動し、スレッドを 2 本起こす。1 本は出力を base64 にして `Channel<PtyEvent>` で WebView に流し、もう 1 本は子プロセスの終了を待って `Exit` を送る。フロントは xterm.js で描画し、出力のタイミングから「Running / Idle / Exited」のタイル表示を決める。

### メモリモデル

`memory.rs` は、RDP セッションをもう 1 本開いたときに必要なメモリを見積もり、接続前に UI が警告できるようにする。1 セッションを「`BASE_SESSION_BYTES` + `BASE_BYTES_PER_PIXEL` × 画素数」とみなし、学習した倍率を掛ける。裏のスレッドが 3 秒ごとに `sysinfo` でプロセスツリー全体（Iruka 本体と WebView などの子。スレッドは除く）のメモリを記録する。

- RDP セッションがないとき（起動後 15 秒の暖機のあと）、いちばん小さい値をこの起動の**基準値**にする。
- セッションがあるとき、`倍率 = (使用量 − 基準値) / base_estimate(sessions, pixels)` を観測値の一覧に足す（最大 1200 個、約 1 時間分）。
- 見積もりは、観測値が 20 個以上そろったら**上位 5%（95 パーセンタイル）**の値を使い、**ゆとり 1.2 倍**を掛ける。観測値はアプリのデータディレクトリの `memory-model.json` に 60 秒ごとに保存し、起動時に読み込む。

`rdp_memory_check` は OS から取った空きメモリと見積もりを返す。デバッグビルドでは `IRUKA_FAKE_AVAILABLE_MB` で空きメモリを偽装して確認画面を試せる。`lib.rs` では Linux の glibc の `M_MMAP_THRESHOLD` を 256 KB にして、大きな画面バッファーが解放されたらスレッドごとのアリーナに残らず OS に返るようにしている。

### クリップボード

テキストのみ、表示中のセッションのみ。`clipboard.rs` はプロセスの生存中ずっと 1 つの `arboard::Clipboard` を持ち（X11 では持ち主のオブジェクトが生きている間だけ他のアプリが中身を読める）、`ACTIVE` のセッション ID を持つ。`rdp_set_active`（フォーカスが変わるとフロントが呼ぶ）が ID を記録し、ローカルのテキストを `Command::ClipboardLocal` でそのセッションに渡す。`FrameSink::clipboard_from_remote` は、コピーしたセッションがアクティブなときだけローカルのクリップボードに書く。改行はリモート向けには CRLF、Windows 以外のローカル向けには LF にそろえる。C の橋渡しでは `iruka_on_channel_connected` で cliprdr をつなぐ。サーバーの Format List が来たら `CF_UNICODETEXT` を要求し、応答を `remote_text` に置いて Rust のループに取りに来させ、サーバーからのデータ要求には `local_text` で答える。

### カーソルの形

RDP ではカーソルは画面の画像に含まれない。サーバーは形をポインター更新として送り、ユーザーの動きに合わせて（キャッシュからも）1 つを選ぶ。C の橋渡しは `graphics_register_pointer` でポインタークラス（`iruka_pointer_*`）を登録する。`New` は `freerdp_image_copy_from_pointer_data` で形を RGBA に変換し、新しい ID を付けて待ち行列（`cursor_images`）に入れる。`Set` / `SetNull` / `SetDefault` は選択を記録する（`cursor_id`。ID 0 と 1 はローカルの既定と非表示）。Rust のループはポーリングのたびに待ち行列を `RdpEvent::CursorImage`（base64 の RGBA とホットスポット）として、選択を `RdpEvent::Cursor` として流す。フロント（`rdpSession.ts`）は形を PNG の data URL で `MAX_CURSOR_SHAPES` 個まで持ち、canvas の CSS `cursor` に設定する。`rdp.ts` の `remoteCursorStyle` は画像をデバイスピクセル比で縮小する。canvas はリモートの画素を物理ピクセルで等倍に出すが、CSS のカーソル画像は CSS ピクセルだからである。WebKit は 128×128 CSS ピクセルより大きいカーソル画像を無視する（橋渡しは 256×256 超を捨てる）。Windows でそこに達するのは「マウスポインターのサイズ」をかなり大きくしたときだけで、その場合はローカルの矢印になる。IronRDP はカーソルのイベントを送らないので、既定の矢印のまま。

## 2. スレッドと FFI の境界

FreeRDP セッション 1 本に関わるスレッド:

| スレッド | そこで動くもの |
|---|---|
| セッションスレッド（`rdp_connect` が起こす） | `RdpBackend::run`: ポーリングのループ、すべての `iruka_rdp_*` 呼び出し、`FrameSink::flush`（画素のコピー）、ポインターのコールバック（`iruka_pointer_*`。メインチャネルで届き `iruka_rdp_poll` の中で処理される） |
| 送信スレッド（`FrameSink::new` が起こす） | WebView への `Channel::send` |
| FreeRDP の静的チャネルのスレッド | cliprdr のコールバック（橋渡しの `clip_*`） |
| メモリの記録（`memory::start`） | `sysinfo` の更新、モデルの更新、ファイル保存 |

**動的チャネルは同期に固定している。** `iruka_rdp_new` が `FreeRDP_SynchronousDynamicChannels` を `TRUE` にする。既定では FreeRDP の drdynvc が自分のスレッドを持ち、RDPGFX の描画（`gdi_OutputUpdate` → `EndPaint`）もサーバーの ResetGraphics（`gdi_ResetGraphics` → `DesktopResize` → `gdi_resize`）もそこで走る。`gdi_resize` は `gdi->primary_buffer` を解放して作り直す。2026-10-13、2 本目の 4K セッションを接続した直後、drdynvc のスレッド上の ResetGraphics がバッファーを作り直している最中に、Rust のループがセッションスレッドで 4K のフルフレーム（150 ms 前後）をコピーしていて、`memcpy` が解放済みのメモリを読んで segfault した。変化矩形の一覧も同じ形で競合していた。動的チャネルを同期にすれば、`gdi` に触るものはすべて `iruka_rdp_poll` を呼ぶスレッドで動く。

ここから導かれる決まり:

- `iruka_rdp_*` の関数はセッションスレッドからだけ呼ぶ。`freerdp.rs` の `Session` 構造体はわざと `Send` にしていない。
- `FrameView` は `gdi->primary_buffer` を生ポインタ（`iruka_rdp_framebuffer`）で借りている。スライスが有効なのは**次の `iruka_rdp_poll` まで**。poll をまたいで持たない、別スレッドに渡さない。`flush` は戻る前に必要な分をコピーする。
- `IrukaContext` の変化矩形の一覧は、同じスレッドの `iruka_rdp_take_dirty` が読んでリセットする。
- cliprdr は静的仮想チャネルで、そのコールバックは FreeRDP のチャネルスレッドで**動く**。セッションスレッドと共有するもの（`cliprdr`, `clip_ready`, `local_text`, `remote_text`）はすべて `clip_lock`（`CRITICAL_SECTION`）で守り、受け渡しは所有権の移動で行う。`iruka_rdp_take_remote_text` はロックの中でポインタを持ち出し、Rust 側が `iruka_rdp_free_text` で解放する。
- C に渡す文字列は `CString`。NUL を含むテキストは最初の NUL で切る（`set_local_text`）。

IronRDP バックエンドに FFI はない。セッションスレッドで、`commands` を捌くのと、ソケットの読み取りタイムアウト 15 ms の `read_pdu` とを交互に行う。

## 3. 弱いところ

開発に参加する人向けに、宣伝ではなく正直に書く。動いてはいるが荒いもの、広く公開する前に変えるべきものを挙げる。

**(a) グローバル・静的な状態がモジュールに散らばっている。** クリップボードのアクティブなセッション ID は `clipboard.rs` の `AtomicU32`、メモリモデルは `memory.rs` の `LazyLock<Mutex<Model>>` と `SESSION_SIZES` のマップ（JSON で永続化）、セッションの登録は `RdpState`（Tauri が管理）、セッション ID のカウンターは `lib.rs` の static。どれも小さくて動くが、「どのセッションがアクティブで、何を持っているか」の流れが 4 つのファイルにまたがっていて追いにくい。セッション管理の型を 1 つにまとめるのが素直なリファクタリング。

**(b) メモリ見積もりの定数は実測値。** `BASE_SESSION_BYTES`（1 セッションの固定分 150 MB）と `BASE_BYTES_PER_PIXEL`（66 B/px）は、2026-10-09 に Iruka 全体で計測した値から来ている。FreeRDP は 1080p で約 290 MB、4K で `/gfx:small-cache` 込みで約 610〜780 MB、IronRDP は 4K で約 325 MB。学習するのは全体の倍率だけ（観測値の 95 パーセンタイル × 1.2）で、固定分と画素分の比は決め打ち。1080p セッションの heaptrack の内訳は [KNOWN_ISSUES_JA.md](../KNOWN_ISSUES_JA.md) にあり、そのうち約 18 B/px が FreeRDP の使わない 2 組目の codec によることも説明している。数字は FreeRDP のバージョンや WebView で変わる。確定した事実ではなく出発点として扱うこと。

**(c) 認証情報と証明書。** パスワードはプロセス内の argv の `/p:` として FreeRDP に渡す（`freerdp.rs`）。プロセスを起動しないのでプロセス一覧には出ないが、FreeRDP はコマンドラインのパスワードについて警告を出し、文字列は引数の一部としてメモリに残る。予定している直し方は、argv から解析させるのをやめ、C の橋渡しで設定 API の `FreeRDP_Password` に直接入れること。どちらのバックエンドもサーバー証明書を検証しない（FreeRDP は `/cert:ignore`、`ironrdp.rs` は `NoCertificateVerification`）。mstsc で毎回「続行」を押すのと同じで、信頼できる LAN では問題ないが、それ以外では不適切。証明書のピン留めも初回確認もない。

**(d) デバッグログが既定で有効。** `lib.rs` の `tracing` の既定フィルターは `warn,ironrdp_connector=debug,ironrdp_blocking=debug,iruka_lib=debug,iruka_perf=debug,iruka_mem=debug` で、`IRUKA_LOG`（`EnvFilter`）で上書きできる。`iruka_perf` はキューに入れた・送ったフレームすべてのサイズと時間、キー入力を記録し、`iruka_mem` は 3 秒ごとにメモリの記録を出す。調整中はこれでよいが、うるさいので、公開前にはオプトイン（既定は `warn` のみ、デバッグ用ターゲットは `IRUKA_LOG` で有効化）にするべき。

**(e) IronRDP バックエンドは予備でしかない。** RDPGFX を実装していないので GNOME Remote Desktop は拒む。音声、マイク、クリップボードはない（`ClipboardLocal` は無視）。`enable_audio_playback` は false。libfreerdp のないビルドでも Windows につながるように、また純 Rust の経路の参考として置いてある。機能の同等性は期待しないこと。

**(f) UI の文字列は英語を直書きしていて、i18n の層がない。** `App.tsx`、`src/components`、`src/rdp.ts` のラベル（たとえば `RDP_BACKENDS`）、ダイアログの文、Rust から返す切断理由（"Connection failed: …"、"Disconnected"、"The server closed the connection"、"Communication error: …"。UI では "Connection error (FreeRDP): …" / "Disconnected (FreeRDP): …" の形で出す）はコードの中の文字列リテラル。別の言語を足すには、まずメッセージカタログを入れる必要がある。

**(g) テストが薄い。** UI の自動テストやエンドツーエンドのテストはない。Rust のユニットテストは小さなヘルパーにしかない。

- `memory::tests::learns_scale_from_observations` — 観測値から倍率を学習し、別の解像度に当てはめる
- `clipboard::tests::newlines_become_crlf_once` — CRLF の正規化は何度やっても同じ
- `rdp::tests::detects_own_addresses` — `is_local_host` がループバックを自分と判定し、TEST-NET のアドレスを除外する

`src-tauri` で `cargo test` を実行する。FreeRDP、WebView、実際のサーバーに触るものは手で試している。

## 4. 決めごと

- コードのコメントと文書は英語で書く。日本語の文書は英語ファイルの双子として `*_JA.md` で持ち、各ファイルの先頭に 1 行の言語切り替えを置く。
- 1.0 未満の間はコミットを `main` に直接入れる。作者自身の作業ではフィーチャーブランチやプルリクエストを使わない。
- 原因が FreeRDP（や OS）にある問題は、Iruka 側で回避せずに [KNOWN_ISSUES_JA.md](../KNOWN_ISSUES_JA.md) に記録する。そこにある「使わない codec バッファー」の項が手本で、回避策のコードと、それを採らない理由を書いてある。
- C の橋渡しは薄く保つ。小さな C の API（`iruka_rdp_*`）を出し、コマンドラインを解析させて FreeRDP 自身の既定値を使う。おかしくなったときに `xfreerdp` と動作を比べられるようにするため。
- バックエンドは `RdpBackend` だけを実装する。セッション管理、画面の受け渡し、クリップボード、メモリの計上は `rdp/mod.rs` と共通モジュールに置いたままにする。
