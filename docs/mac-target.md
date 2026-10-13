# Mac を接続先にする方法の調査（2026-10-09、結果 2026-10-13）

Ubuntu / Windows で動く Iruka から、Mac の画面を見る方法の調査結果と、次に試すこと。
Mac を監視端末として使う（Iruka を Mac で動かす）話は別で、ここでは扱わない。

## 結果（2026-10-13）

**clintcan/macrdp を Mac に入れ、Iruka を変更せずに FreeRDP バックエンドで接続できた。** 当面は VNC バックエンドを作らず、この方法で運用する。

- 事前に Remmina（RDP）から同じ macrdp に接続できることを確かめてから、Iruka で接続した。
- 確認できたもの: 画面表示と操作、キー入力、Mac での漢字入力、クリップボードの双方向（ローカル → リモート、リモート → ローカル）。
- 解像度 3840×2160 で接続。FreeRDP のログに codec や gfx のエラーはなし（既定のビットマップ送信のままでつながる）。
- メモリ: セッション 1 本で Iruka 全体が約 890MB（起動直後は約 410〜530MB）。Windows の 4K と同程度。
- 保留: **Option+V でペーストできない**（Ctrl+V 相当のキーはリモートに届いている。Mac 側の修飾キーの割り当てか macrdp の変換の問題と思われる）。運用上は困らないので調べていない。KNOWN_ISSUES.md に記録。
- 未確認: 音声、マイク、Retina（`--hidpi`）の有無による解像度の違い、全画面、右 Alt の一覧切り替え。

## 調査時の結論（2026-10-09）

現実的な選択肢は 2 つ。RustDesk は Iruka に組み込むには向かない。

| 方法 | Iruka 側の作業 | Mac 側 | 向き不向き |
|---|---|---|---|
| 1. macOS 標準の画面共有（VNC）に接続 | VNC バックエンドを追加（中規模） | 設定でオンにするだけ | 追加ソフト不要。長期的にはこちら |
| 2. Mac に RDP サーバーを入れる（macrdp、または Remotr） | なし（FreeRDP でそのまま） | macrdp はオープンソース（MIT / Apache-2.0）、Remotr は有料（無料版あり） | すぐ試せる。まず macrdp |

## 1. macOS 標準の画面共有（VNC）

Mac 側は「設定 → 共有 → 画面共有」をオンにする。認証方式が 2 つあり、実装量を左右する。

| 認証方式 | Mac 側の設定 | Rust ライブラリの対応 |
|---|---|---|
| 標準の VNC 認証（パスワードのみ、セキュリティタイプ 2） | 画面共有の設定（「コンピュータ設定」）で「VNC 使用者が画面を操作することを許可」にパスワードを設定 | `vnc-rs` がそのまま対応 |
| Apple 独自の認証（セキュリティタイプ 30、ユーザー名とパスワード、Diffie-Hellman + AES） | 既定のまま | `vnc-rs` は未対応。自前で足す |

### 使うライブラリと参考実装

- **`vnc-rs`**（crates.io）: Rust 製の VNC クライアント。MIT / Apache-2.0。0.6.0（2026-09-21）。tokio の非同期。Tight / ZRLE / Raw / CopyRect に対応（Hextile / RRE は未実装、TRLE は未試験）。作者が「macOS 12.6 の内蔵 VNC サーバー（パスワードログイン有効）」で試験済み。
- **`rv`**（github.com/madeye/rv）: Rust 製の VNC ビューアー。MIT。`vnc-rs` 0.5.3 を使い、Mac の画面共有の ARD ログイン（タイプ 30）を自前で実装している。同じ MIT なので、認証部分を Iruka に移植できる。
- **libvncclient**（LibVNC/libvncserver）: C。`HandleARDAuth` にタイプ 30 の実装がある。GPL-2 なので、読むだけにしてリンクしない。

### Iruka への組み込み（設計メモ）

- `RdpBackend` トレイト（`src-tauri/src/rdp/mod.rs`）の `run` を実装すれば差し込める。画面は自前のバッファーに書いて `FrameSink` の `damage` / `flush` に渡す。セッション管理、サムネイル、一覧、全画面、クリップボードの仕組みは共通。
- **キー入力だけ設計上の差がある**: RDP はキーの位置（スキャンコード）、VNC は文字（X11 の keysym）を送る。フロントの keydown で `KeyboardEvent.key` も一緒に送るようにし、VNC 側で keysym に変換する。
- 接続フォーム: 方式に「VNC」を足す。ポートの既定は 5900。認証はパスワードだけ（Apple 独自認証ならユーザー名も）。音声 / マイク / 省メモリは効かない（RDP 専用）。
- 追加するときは、トレイトと設定の名前を `RdpBackend` / `RdpConnectParams` から汎用の名前に変える。
- 制限: 音声なし。クリップボードの基本は Latin-1 で、日本語は Extended Clipboard 拡張しだい（macOS の対応は未確認）。VNC は画面の展開を CPU で行うので、Retina の高解像度では重くなる可能性がある。

## 2. Mac に RDP サーバーを入れる

### macrdp（clintcan/macrdp）— まず試す

- github.com/clintcan/macrdp。Rust + IronRDP で書かれた macOS 用のネイティブ RDP サーバー。**MIT または Apache-2.0**。2026-05 開始、最新 v0.9.11（2026-10-02）。
- **画面の送り方は既定がビットマップ**で、H.264（ハードウェアエンコード）はオプション（`--enable-h264`）。Ubuntu の FreeRDP は H.264 なしでビルドされているので、既定のままでつながる見込み。
- 認証は NLA / CredSSP で、Mac のアカウント（ユーザー名とパスワード）を使う。mstsc、Microsoft Remote Desktop、**FreeRDP で検証済み**と README に明記。
- 対応: クリップボード（テキスト、画像、リッチテキスト、ファイル）、音声、マイク（実験的）、Retina（`--hidpi`）、仮想ディスプレイ（ヘッドレス）、キーボード配列の自動検出、Cmd キーのショートカット再現。
- 制限: 1 セッション / 1 ユーザーのみ、マルチモニターなし。v0 で「LAN か VPN での 1 人利用なら実用」という位置づけ。
- 既定ポートは **3390**（3389 ではない）。
- 導入: Mac で `cargo build --release` するか、GitHub Releases の Apple Silicon 用バイナリ（ad-hoc 署名、未公証なので初回は右クリック → 開く）。初回起動時に「画面収録」と「アクセシビリティ」の権限を許可し、Mac のパスワードを入力する。
- 注意: **同名の別プロジェクト x6nux/macrdp（GPL-3.0）がある。** そちらは H.264（AVC420 / AVC444）だけの記述で、Ubuntu の FreeRDP では画面が出ない可能性がある。混同しないこと。

### Remotr — macrdp がうまくいかないとき

- **Remotr**: 2026 年 3 月に出た macOS 用のネイティブ RDP サーバー。開発者の説明では、MS-RDPBCGR 仕様に基づく実装で、ビットマップと H.264、クリップボード、macOS アカウントでの認証に対応。買い切り 10〜20 ドルで、機能制限つきの無料版がある。macOS 13 以降。
- Iruka 側は変更なし。FreeRDP バックエンドで接続する。
- 注意: 出たばかりで第三者のレビューや検証が見つからない。情報源は開発者の投稿と紹介サイトのみ。FreeRDP との相性（RDPGFX と H.264 の扱い。Ubuntu の FreeRDP は H.264 なしでビルドされている）は、実際に確かめる必要がある。

## 候補から外したもの

- **RustDesk**: AGPL-3.0。組み込むと Iruka 全体が AGPL になり、MIT を保てない。SDK や公開されたプロトコル仕様がない。別アプリとして動かせるが、Iruka のサムネイルや一覧には入らない。
- **libvncclient**（GPL-2）、**gtk-vnc / gvnc**（LGPL、Windows で使いにくい）、**Sunshine + Moonlight**（GPL、ゲーム配信向けで用途が違う）。

## 次のセッションで試すこと

A は 2026-10-13 に完了（上の「結果」）。B と C は、macrdp で困ったときに戻ってくる。

### A. macrdp で、今の Iruka からつなぐ（コード変更なし）— 完了

1. Mac に clintcan/macrdp を入れる（Releases のバイナリか `cargo build --release`）。起動して、画面収録とアクセシビリティの権限を許可し、Mac のパスワードを入力する。LAN から受けるには `--bind 0.0.0.0:3390`。
2. Iruka の「＋ RDP」で、ホストに `Mac の IP アドレス:3390`（ポートを忘れない）、Mac のアカウントのユーザー名とパスワード、方式「自動（FreeRDP 優先）」で接続する。
3. 確認すること: 画面が出るか、解像度（Retina。`--hidpi` の有無で変わる）、キー入力とマウス、クリップボード、音声（接続フォームの「音声」をオン）、全画面、メモリ使用量（`iruka_mem` のログ）。
4. つながらないときは、`npm run tauri dev` の端末に出る FreeRDP のログ（`[ERROR]`、`codec`、`gfx`）と、macrdp 側のログを見る。Iruka は `/gfx` を指定しているので、RDPGFX の扱いで相性が出る可能性がある。
5. macrdp で足りなければ Remotr の無料版を試す（手順は同じ。ポートは 3389）。

### B. VNC の下見（コード変更なし）

1. Mac の画面共有をオンにし、「VNC 使用者が画面を操作することを許可」にパスワードを設定する。
2. Ubuntu の Remmina（VNC）で、パスワードだけで接続できることを確かめる。これで Mac 側の設定が正しいとわかる。
3. できれば、Remmina で Apple 独自認証（ユーザー名とパスワード）でもつながるか見る。

### C. VNC バックエンドの実装（A と B の結果しだい）

1. `vnc-rs` を依存に足し、`RdpBackend` を実装する `vnc.rs` を書く（まずは標準の VNC 認証、Raw / ZRLE / Tight）。
2. フロントの keydown で `KeyboardEvent.key` を送るようにし、keysym の変換表を作る。
3. 接続フォームに「VNC」を足す。
4. 動いたら、`rv` を参考に Apple 独自認証（タイプ 30）を足す。

## 出典

- [vnc-rs（docs.rs）](https://docs.rs/crate/vnc-rs/latest)
- [madeye/rv — Native desktop VNC viewer in Rust](https://github.com/madeye/rv)
- [Tenable: Detecting macOS High Sierra root account（認証タイプ 30 = ARD の解説）](https://www.tenable.com/blog/detecting-macos-high-sierra-root-account-without-authentication)
- [KDE Bug 286138: Support for ARD authentication](https://bugs.kde.org/show_bug.cgi?id=286138)
- [clintcan/macrdp — A native RDP server for macOS, written in Rust on top of IronRDP](https://github.com/clintcan/macrdp)
- [x6nux/macrdp（同名の別プロジェクト、GPL-3.0）](https://github.com/x6nux/macrdp)
- [Remotr — Native macOS RDP Server（AlternativeTo）](https://alternativeto.net/software/remotr--native-macos-rdp-server/about/)
- [Show GN: RDP用 macOS ネイティブ リモートサーバー（開発者の投稿）](https://news.hada.io/topic?id=27916)
- [Product Hunt: Remotr の作者プロフィール](https://www.producthunt.com/@kimbongchul)
- [Gentoo: net-misc/rustdesk（AGPL-3）](https://gpo.zugaina.org/net-misc/rustdesk)
- [Wikipedia: LibVNCServer（GPLv2）](https://en.wikipedia.org/wiki/LibVNCServer)
