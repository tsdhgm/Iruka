# Mac を接続先にする方法の調査（2026-10-09）

Ubuntu / Windows で動く Iruka から、Mac の画面を見る方法の調査結果と、次に試すこと。
Mac を監視端末として使う（Iruka を Mac で動かす）話は別で、ここでは扱わない。

## 結論

現実的な選択肢は 2 つ。RustDesk は Iruka に組み込むには向かない。

| 方法 | Iruka 側の作業 | Mac 側 | 向き不向き |
|---|---|---|---|
| 1. macOS 標準の画面共有（VNC）に接続 | VNC バックエンドを追加（中規模） | 設定でオンにするだけ | 追加ソフト不要。長期的にはこちら |
| 2. Mac に RDP サーバー（Remotr）を入れる | なし（FreeRDP でそのまま） | 有料アプリ（無料版あり） | すぐ試せる。製品が新しく情報が少ない |

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

## 2. Mac に RDP サーバーを入れる（Remotr）

- **Remotr**: 2026 年 3 月に出た macOS 用のネイティブ RDP サーバー。開発者の説明では、MS-RDPBCGR 仕様に基づく実装で、ビットマップと H.264、クリップボード、macOS アカウントでの認証に対応。買い切り 10〜20 ドルで、機能制限つきの無料版がある。macOS 13 以降。
- Iruka 側は変更なし。FreeRDP バックエンドで接続する。
- 注意: 出たばかりで第三者のレビューや検証が見つからない。情報源は開発者の投稿と紹介サイトのみ。FreeRDP との相性（RDPGFX と H.264 の扱い。Ubuntu の FreeRDP は H.264 なしでビルドされている）は、実際に確かめる必要がある。

## 候補から外したもの

- **RustDesk**: AGPL-3.0。組み込むと Iruka 全体が AGPL になり、MIT を保てない。SDK や公開されたプロトコル仕様がない。別アプリとして動かせるが、Iruka のサムネイルや一覧には入らない。
- **libvncclient**（GPL-2）、**gtk-vnc / gvnc**（LGPL、Windows で使いにくい）、**Sunshine + Moonlight**（GPL、ゲーム配信向けで用途が違う）。

## 次のセッションで試すこと

### A. Remotr で、今の Iruka からつなぐ（コード変更なし）

1. Mac に Remotr の無料版を入れ、RDP サーバーを有効にする。
2. Iruka の「＋ RDP」で、Mac の IP アドレス、Mac のアカウントのユーザー名とパスワード、方式「自動（FreeRDP 優先）」で接続する。
3. 確認すること: 画面が出るか、解像度（Retina の扱い）、キー入力とマウス、クリップボード、全画面、メモリ使用量（`iruka_mem` のログ）。
4. つながらないときは、`npm run tauri dev` の端末に出る FreeRDP のログ（`[ERROR]`、`codec`、`gfx`）を見る。無料版の機能制限で止まる場合もある。

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
- [Remotr — Native macOS RDP Server（AlternativeTo）](https://alternativeto.net/software/remotr--native-macos-rdp-server/about/)
- [Show GN: RDP用 macOS ネイティブ リモートサーバー（開発者の投稿）](https://news.hada.io/topic?id=27916)
- [Product Hunt: Remotr の作者プロフィール](https://www.producthunt.com/@kimbongchul)
- [Gentoo: net-misc/rustdesk（AGPL-3）](https://gpo.zugaina.org/net-misc/rustdesk)
- [Wikipedia: LibVNCServer（GPLv2）](https://en.wikipedia.org/wiki/LibVNCServer)
