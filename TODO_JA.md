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
- [ ] クライアントの Windows ビルド（FreeRDP 3 を Windows 向けに用意する必要がある）。
- [ ] UI の自動テスト。Rust の単体テストは小さな補助関数だけ。
- [ ] 保存した接続のパスワードを OS のキーリングに預ける（Remmina の secret プラグインと同じ方式。Linux は Secret Service（GNOME Keyring / KWallet）、Windows は資格情報マネージャー、macOS はキーチェーン）。案: Rust の `keyring` クレートを Tauri コマンド 2 つ（プロファイル ID で取得 / 保存）で包む。フロントのプロファイルには引き続きパスワードを持たせない。それまでは接続のたびに入力する。

## 完了

- [x] 2026-10-13: clintcan/macrdp 経由で Mac に接続。Iruka の変更なし（docs/mac-target_JA.md）。
- [x] 2026-10-13: 4K セッション 2 本での segfault を修正（動的チャネルを poll のスレッドで処理）。
- [x] 2026-10-13: App.tsx をモジュールに分割。コメント、UI、文書を英語化し、日本語は `*_JA.md` に。
