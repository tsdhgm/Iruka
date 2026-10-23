*English: [TODO.md](TODO.md)*

# TODO

残っている課題と、これから確認すること。Iruka の外（FreeRDP や OS）にある不具合はここではなく [KNOWN_ISSUES_JA.md](KNOWN_ISSUES_JA.md) に書く。設計上の弱いところは [docs/code-notes_JA.md](docs/code-notes_JA.md) にある。

## 2026-10-13 の整理（App.tsx の分割、UI の英語化）の後で確認すること

2026-10-13 に簡単に確認した範囲では問題なし。あらためて確かめる項目:

- [ ] 接続フォーム: 英語の項目名（Resolution、Backend、Audio、Microphone、Low memory、Clipboard）と、保存されるフォームの値（`iruka.rdpForm`）が分割前と同じか。
- [ ] 接続、一覧表示、右 Alt の表示切り替え、全画面が分割前とまったく同じに動くか（右 Alt + キーをリモートへ遅らせて送る動きを含む）。
- [ ] コンソールのバッジ「Running」「Idle 5m」「Exited」の文言とタイミング。
- [ ] 切断時の表示が「Disconnected (FreeRDP): …」「Connection error (FreeRDP): …」になっているか。

## Mac（clintcan/macrdp）

- [ ] マイクの転送。
- [ ] Retina で `--hidpi` の有無による解像度の違い。
- [ ] Option+V でペーストできない（保留。KNOWN_ISSUES_JA.md 参照）。

## Ubuntu GNOME Remote Desktop

- [ ] 音声、マイク、クリップボード、Low memory は Windows でしか確認していない。GNOME Remote Desktop でも確かめる。

## キー入力

- [ ] 日本語キーボード: US 配列にないキー（変換 / 無変換 / 半角全角 / カタカナひらがな）を確認する。
- [ ] 表示切り替えキーの設定画面（今は `localStorage` の `iruka.viewToggleKey` だけ）。

## UI の微調整（作者が後回しにしたもの）

- [ ] 一覧表示の列数スライダーの微調整。
- [ ] コンソールのバッジの微調整（「Running」と判定する 2 秒の幅、待機時間の表記）。
- [ ] デュアルモニター対応。未決: Iruka のウィンドウを 2 つにして、片方に一覧、もう片方にセッションの全画面、という形にするか。

## 1.0 までに

- [ ] パスワードを、プロセス内の `/p:` 引数ではなく FreeRDP の設定 API で渡す（デバッグ中は今のまま。FreeRDP が警告を出す）。
- [ ] `iruka_perf` / `iruka_mem` のデバッグログを明示的に有効にしたときだけ出す（今は `src-tauri/src/lib.rs` の既定フィルターで有効）。
- [ ] `/cert:ignore`（証明書を検証しない。LAN 専用）の扱いを決める。
- [ ] （作者が後回しにした、2026-10-23。）セッションを閉じても残るメモリ（両クライアント。数字は docs/code-notes_JA.md「メモリモデル」）: Linux では閉じた後に約 600 MB が残り、大半は本体プロセスの常駐した glibc malloc アリーナ。セッション終了時の `malloc_trim(0)` か `M_ARENA_MAX` を試して測り直し、本当のリークがないか heaptrack で見る。
- [ ] Ubuntu（GNOME Remote Desktop）の音声が、クライアントは音声の出力先を読み込んでいるのにリモート側で鳴ったまま（Windows クライアントで確認。マイクは動く）。後回し。Linux 版と比べる（docs/windows-client-log_JA.md）。
- [ ] KDE（など GNOME 以外のデスクトップ）で Iruka を試す: `StartupWMClass` によるウィンドウとアイコンの対応、右 Alt の切り替え、クリップボード。
- [ ] Windows のインストーラー: FreeRDP / OpenSSL の DLL（`legacy.dll` を含む）を `bundle.resources` で同梱し、起動時に `OPENSSL_MODULES` を設定する（KNOWN_ISSUES_JA.md）。
  - 配布の方針: 当面は署名なし。Tauri の NSIS インストーラーとポータブル zip（exe と DLL。インストールも管理者権限も不要。WebView2 は Windows 11 に入っている）の両方を出す。README に「SmartScreen の警告が出たら『詳細情報 → 実行』」と書く。
  - zip でも SmartScreen は避けられない: エクスプローラーで展開すると Mark of the Web が引き継がれる。署名だけでも避けられない: EV でも最初から評判は付かず、ビルドごとに評判はゼロから。
  - 広く配布するときの選択肢:
    - Azure Artifact Signing: 有料（月 $10 程度）。OSS 向けの無料枠はない。無料・試用・スポンサー付きの Azure サブスクリプションは使えない。個人は米国・カナダのみ。法人の対象の国と地域は資料によって違う（日本を含む／含まない）ので、使う前に Microsoft の公式ページで確かめる。
    - SignPath Foundation（Microsoft の制度ではない。Microsoft の説明ページが OSS 向けに紹介している）: 条件を満たし CI/CD でビルドしている OSS は無料。Windows に出る発行元は「SignPath Foundation」になり、リリースごとに SignPath 側で手動の承認が要る。実行ファイルには人による最初の審査で「検証できる一定の評判」が求められるので、Iruka に利用者がつくまでは無理（docs/windows-client-log_JA.md）。
    - Microsoft Store。
- [ ] コンソールのプロファイル: コンソールごとにシェルを選べるようにする（PowerShell、cmd、WSL、bash など）。今は `$SHELL`、なければ Windows では `powershell.exe`、それ以外は `bash`。
- [ ] UI の自動テスト。Rust の単体テストは小さな補助関数だけ。
- [ ] 保存した接続のパスワードを OS のキーリングに預ける（Remmina の secret プラグインと同じ方式。Linux は Secret Service（GNOME Keyring / KWallet）、Windows は資格情報マネージャー、macOS はキーチェーン）。案: Rust の `keyring` クレートを Tauri コマンド 2 つ（プロファイル ID で取得 / 保存）で包む。フロントのプロファイルには引き続きパスワードを持たせない。それまでは接続のたびに入力する。

## 完了

- [x] 2026-10-23: Windows クライアントとのメモリ比較（docs/code-notes_JA.md「メモリモデル」）: 3840×2160 を 1 本のコストは Linux で約 550 MB、Windows で約 1.2 GB。
- [x] 2026-10-23: リモート画面上のカーソルがリモートの形になる（FreeRDP のポインター更新 → CSS cursor。docs/code-notes_JA.md「カーソルの形」）。
- [x] 2026-10-16: Linux のパッケージ: `.deb`（`scripts/make-deb.sh`。Ubuntu の FreeRDP 3 に依存）と自己完結の tar アーカイブ（`scripts/make-tarball.sh`: RPATH `$ORIGIN/lib`、`lib/` の FreeRDP 3 ライブラリ、`check-deps.sh`）。
- [x] 2026-10-16: 自分で使う用の Windows ポータブル zip（docs/windows-client_JA.md の「ポータブル zip」）。
- [x] 2026-10-16: Windows クライアントから Windows の接続先へ: FreeRDP（NLA、音声、マイク、クリップボード）と IronRDP。右 Alt、全画面、ドロップダウンのツールバーも動作（docs/windows-client_JA.md）。
- [x] 2026-10-16: クライアントの Windows ビルド。vcpkg の FreeRDP 3.32.1 で開発ビルドが動作し、GNOME Remote Desktop に接続できた（docs/windows-client_JA.md）。
- [x] 2026-10-13: clintcan/macrdp 経由で Mac に接続。Iruka の変更なし（docs/mac-target_JA.md）。
- [x] 2026-10-13: 4K セッション 2 本での segfault を修正（動的チャネルを poll のスレッドで処理）。
- [x] 2026-10-13: App.tsx をモジュールに分割。コメント、UI、文書を英語化し、日本語は `*_JA.md` に。
