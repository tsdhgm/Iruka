*English: [README.md](README.md)*

# Iruka

複数の PC を一度に見守るためのビューアー。SSH などのコンソールとリモートデスクトップ（RDP）を、左のサイドバーにライブのサムネイルとして並べ、クリックで右側に大きく表示する。表示していないセッションも接続したまま動き続ける。

Tauri 2 + React + TypeScript。RDP は FreeRDP 3 を使う（予備として IronRDP も組み込んである。experimental 扱い）。

**状態**: 個人用の初期段階のツール（1.0 未満）。クライアントは Ubuntu 26.04 LTS、接続先は Windows 11 Pro、Ubuntu の GNOME Remote Desktop、Apple Silicon の macOS（macrdp）で試している。

## 主な機能

### コンソール

- ローカルのシェルを開く（xterm.js で表示）。

### リモートデスクトップ（RDP）

- **接続先**: Windows のリモートデスクトップ、Ubuntu の GNOME Remote Desktop（画面共有）、Mac（[clintcan/macrdp](https://github.com/clintcan/macrdp) を入れたもの。ホストは `IP:3390`）。
- **表示**: リモートの 1 ピクセルを画面の 1 ピクセルで表示する（等倍）。はみ出す分はスクロールで見る。サムネイルだけ縮小する。
- **カーソルの形**: リモート画面の上では、リモートが指定した形のカーソルになる（ウィンドウの枠でサイズ変更の矢印、テキストの上で I 字形、リンクの上で指の形、リモートが隠している間は非表示）。FreeRDP のみ。IronRDP ではローカルの矢印のまま。
- **全画面**: 画面上端中央のつまみにマウスを乗せると、ツールバーが降りてくる。「Fullscreen（全画面）」/「Exit fullscreen（全画面解除）」、「Disconnect（切断）」、「Keep toolbar open（ツールバーを出したままにする）」がある。
- **一覧表示**: ツールバーの「Grid view（一覧表示）」で、全セッションを 16:9 のタイルで並べる（「Single view（単独表示）」で戻る）。「Columns（列数）」のスライダーで 1〜6 列に変えられ、縦にはみ出す分はスクロールする。タイルをクリックすると、そのセッションの単独表示に戻る。カーソルキー、Tab / Shift+Tab（と Home / End）で選択枠を動かし、Enter で開くこともできる。キーボードのフォーカスがセッションの外にあるとき（一覧表示中、またはサイドバーや余白をクリックした後）は、F11 で全画面を切り替え、Esc で全画面を解除できる（セッションの中ではこれらのキーはリモートに送られるので、表示切り替えキーかクリックで一度外に出てから）。コンソールのタイルには「Running（実行中）」「Idle 5m（待機 5 分）」「Exited（終了）」のバッジが出る（直近 2 秒以内に出力があれば Running。Claude Code などのスピナーは動作中ずっと出力しているので、これで入力待ちかどうかがわかる）。
- **表示切り替えキー**: 右 Alt を単独で押して離すと、一覧と単独表示を行き来する（全画面中も有効）。右 Alt を押したまま別のキーを押せば、普通の Alt としてリモートに送られる。右 Alt 単独はリモートに届かなくなるので、Alt 単独の操作（Windows のメニューバーへのフォーカスなど）は左 Alt で行う。キーは `localStorage` の `iruka.viewToggleKey`（`KeyboardEvent.code`、例: `ControlRight`）で変えられる。設定画面はまだない。
- **接続フォーム**: 「Host（ホスト）」「User（ユーザー名）」「Password（パスワード）」と下の設定項目、「Connect（接続）」/「Cancel（キャンセル）」。

  | 項目 | 内容 | 初期値 |
  |---|---|---|
  | Resolution（解像度） | 「Same as local（ローカルと同じ）」/「2560×1440」/「1920×1080」。大きいほどメモリを使う | Same as local |
  | Backend（接続方式） | 「Auto (FreeRDP first)（自動、FreeRDP 優先）」/「FreeRDP」/「IronRDP (experimental)」。IronRDP には音声・マイク・クリップボード・Low memory がなく、GNOME Remote Desktop にはつながらない（RDPGFX がない） | Auto (FreeRDP first) |
  | Audio（音声） | リモートの音をローカルで鳴らす | オフ |
  | Microphone（マイク） | ローカルのマイクをリモートへ送る | オフ |
  | Low memory（省メモリ） | RDPGFX のキャッシュを 100MB から 16MB に減らす | オン |
  | Clipboard（クリップボード） | テキストのコピー＆ペーストを共有する | オン |

  Audio、Microphone、Low memory、Clipboard は FreeRDP で接続したときだけ有効。

- **クリップボード（テキストのみ）**: ローカルとリモートで、双方向にコピー＆ペーストできる。多数のセッションを同時に開くので、同期するのは表示中のセッションだけにしている。
  - **ローカル → リモート**: リモート画面にフォーカスが入ったときに、ローカルのテキストをそのセッションに渡す。リモート画面のクリック、セッションの切り替え、ほかのアプリから Iruka に戻ったときが該当する。
  - **リモート → ローカル**: 表示中のセッションでコピーされたテキストだけを、ローカルのクリップボードに入れる。裏のセッションでのコピーや、コンソールを表示している間のコピーは無視する。
  - Windows の改行（CRLF）と Linux の改行（LF）は自動で変換する。

- **メモリ確認**: 接続する前に空きメモリと必要量の見積もりを比べ、足りなければ「Memory may run short（メモリが足りないかもしれない）」の確認画面を出す（「Connect anyway（それでも接続）」/「Cancel」）。見積もりは、実際の使用量から学習した値を使う。接続先がこの PC 自身だったときも、同じ形の「This is the local machine（これはローカルのマシン）」の確認画面が出る。
- **切断時のメッセージ**: セッションが終わると、理由が接続方式の名前と一緒に出る。例: 「Disconnected (FreeRDP): The server closed the connection（切断 (FreeRDP): サーバーが接続を閉じた）」「Connection error (FreeRDP): Connection failed: …（接続エラー (FreeRDP): 接続に失敗）」。バックエンドの理由は「Disconnected（切断した）」「The server closed the connection（サーバーが接続を閉じた）」「Connection failed: …（接続に失敗）」「Communication error: …（通信エラー）」の 4 つ。

### 接続の保存

- **接続の保存**: 「+ SSH」「+ RDP」のフォームから接続すると、毎回サイドバーの「Saved（保存済み）」一覧に残る（`localStorage` の `iruka.profiles`）。「Save（保存）」は接続せずに保存だけする。「Name（名前）」は一覧に出す表示名で、空ならホスト名（または `user@host`）になる。同じホストとユーザーに再度接続すると、増えずに上書きされる。保存するのは、SSH は名前・ホスト・ユーザー名・ポート、RDP は名前・ホスト・ユーザー名と設定項目（Backend、Audio、Microphone、Low memory、Clipboard、Resolution）。パスワードはこの一覧には入れない。RDP または SSH フォームの **「Save password（パスワードを保存）」** を付けると、パスワードは OS の資格情報ストア（Linux は Secret Service 経由で GNOME Keyring / KWallet、Windows は資格情報マネージャー、macOS はキーチェーン）に接続の id をキーとして入り、その保存済み接続をクリックするとすぐ接続する。付けていなければ、クリックするとパスワード以外が埋まったフォームが開く。チェックを外す（または接続を削除する）と保存したパスワードも消える。「+ SSH」（と保存した SSH 接続のクリック）はコンソールを開いて `ssh user@host` を代わりに打ち込む。ホスト鍵の指紋の確認はターミナル上で答える。パスワードも同じだが、フォームで入力または保存してあれば、最初の 1 分以内に出た「password:」で終わる最初のプロンプトに Iruka が一度だけ打ち込む（間違ったパスワードの再入力、鍵のパスフレーズ、ホスト鍵の質問には手を出さない）。パスワードなしでログインするなら、設定できる環境では SSH 鍵のほうがよい。「✎」で編集、「×」で削除。「Saved」の見出しをクリックすると一覧を折りたためる（既定は閉じた状態。`localStorage` の `iruka.savedOpen` に記憶）。
- **ワークセット**: サイドバーの「Worksets」で、開いているセッションを名前付きの集合として保存し（元になった保存済み接続をサイドバーの順に、一覧 / 単一表示と列数も一緒に。ただのコンソールは含まない）、クリック一つで、再起動後でも戻せる。「Last open sessions（最後に開いていたセッション）」はセッションが開いている間、自動で書かれる。復元はセッションを順番に起動し（RDP は次を始める前に最長 20 秒接続を待つ）、RDP はメモリの見積もりが収まる本数だけを保存した順に開く。残りと、パスワードを保存していない RDP 接続は、最後に出る報告に列挙される。すでに開いているセッションはそのまま。ワークセットは `localStorage`（`iruka.worksets`、`iruka.lastWorkset`）にある。

### セキュリティに関する注意

- FreeRDP には `/cert:ignore` を渡しているので、サーバー証明書は検証しない（IronRDP バックエンドも検証しない）。信頼できる LAN の中でだけ使うこと。
- パスワードは、プロセス内の引数 `/p:` として FreeRDP に渡す。プロセス一覧には出ないが、FreeRDP が警告を出す。設定 API への移行を予定している。
- 接続フォームの内容は `localStorage`（`iruka.rdpForm`）に保存する。保存するのは Host、User、Backend、Audio、Microphone、Low memory、Clipboard、Resolution。パスワードはここには**保存しない**（フォームを読み込むたびに空にする）。保存した接続（`iruka.profiles`）とワークセットにもパスワードは入らない。
- 「Save password」を付けたパスワードは OS の資格情報ストアにある。SSH では ssh が尋ねてきたときにキー入力としてコンソールに打ち込むので、コマンドラインにもプロセス一覧にも出ない。Linux ではこのストアはログインセッションの間ずっと解錠されているので、同じセッションで動くどのプログラムでも読める（Remmina や Evolution、保存した Wi-Fi のパスワードと同じ条件）。離席時は画面をロックすること。項目の名前は `dev.tosihide.iruka`、ユーザー欄が接続の id（GNOME の「パスワードと鍵」などで見える）。

## 制限事項と既知の不具合

[KNOWN_ISSUES_JA.md](KNOWN_ISSUES_JA.md) を参照。

## 調査メモ

- [docs/windows-client_JA.md](docs/windows-client_JA.md): Windows で Iruka を動かす（前提、vcpkg での FreeRDP。未着手）。
- [docs/mac-target_JA.md](docs/mac-target_JA.md): Mac を接続先にする方法の調査と、macrdp での接続結果（2026-10-13）。
- [docs/realtime-kill_JA.md](docs/realtime-kill_JA.md): 高負荷時に Iruka が SIGKILL で消えた理由（WebKitGTK のリアルタイム IPC スレッド）、追跡の手順、そこから出た Remmina との設計比較（2026-10-23）。
- [docs/linux-diagnostics_JA.md](docs/linux-diagnostics_JA.md): Linux で Iruka が消えたときの原因の調べ方（終了ステータスのラッパー、ジャーナル、bpftrace の監視）。試行錯誤は [docs/linux-diagnostics-log_JA.md](docs/linux-diagnostics-log_JA.md)（2026-10-24）。

## 開発に参加する人へ

- [docs/code-notes_JA.md](docs/code-notes_JA.md): 設計メモと弱いところ（構成、スレッドと FFI の境界、決めごと）。
- [TODO_JA.md](TODO_JA.md): 残っている課題と、これから確認すること。

## Linux へのインストール

どちらのパッケージも、下の開発環境を入れた Ubuntu で作る。Iruka は GTK 3 / WebKitGTK のアプリなので
GNOME 専用ではないが、試したのは GNOME（Wayland）だけで、KDE などのデスクトップは未検証。

### Debian パッケージ（Ubuntu ではこちらを推奨）

```sh
scripts/make-deb.sh                          # -> release/iruka_<version>_amd64.deb
sudo apt install ./release/iruka_0.1.0_amd64.deb
```

パッケージは Ubuntu 自身の FreeRDP 3（`libfreerdp-client3-3`）、WebKitGTK、GTK に依存するので、足りない
ものは apt が入れ、FreeRDP の更新も apt が面倒を見る。`/usr/bin/iruka`、デスクトップエントリ、アイコンが
入る。

### tar アーカイブ（インストール不要、root 不要）

作る側の Ubuntu に `patchelf` が要る:

```sh
scripts/make-tarball.sh                      # -> release/iruka-<version>-linux-x86_64.tar.gz
```

どこかに展開して `./iruka` を実行するだけでよい。FreeRDP 3 のライブラリ（Ubuntu のもののコピー。作った
ときのバージョンで固定）は `lib/` に同梱してあり、バイナリの RPATH（`$ORIGIN/lib`）で見つかるので、
インストールも `PATH` / `LD_LIBRARY_PATH` の設定も要らない。GTK 3、WebKitGTK 4.1 と FreeRDP 自身が依存する
ライブラリはディストリビューションのものを使う（Ubuntu のデスクトップには全部入っている）。インストール時の
依存チェックはないので、`./iruka` が起動しないときは `./check-deps.sh` を実行する。足りないライブラリと、
それを入れる `apt install` の一行を表示する。`./install-desktop-entry.sh` を実行すると、アプリ一覧に
アイコン付きで登録される。

## 開発

### 必要なもの（Ubuntu）

- Tauri 2 の前提パッケージ（[Tauri のドキュメント](https://v2.tauri.app/start/prerequisites/)を参照）
- FreeRDP 3 の開発用パッケージ: `sudo apt install freerdp3-dev`
- Node.js と Rust

### 起動

```sh
npm install
npm run tauri dev
```

Linux のデスクトップでは、開発ビルドのドックのアイコンが汎用のものになる。一度だけ次を実行すると Iruka のアイコンになる（パッケージ版では不要）:

```sh
scripts/install-desktop-entry.sh
```

RDP の調査用ログは、環境変数 `IRUKA_LOG` で絞り込める（例: `IRUKA_LOG=iruka_mem=debug`）。

## ライセンス

MIT（[LICENSE](LICENSE)）
