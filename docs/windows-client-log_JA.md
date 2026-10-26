*English: [windows-client-log.md](windows-client-log.md)*

# Windows クライアント作業記録（試行錯誤の経緯）

Windows でクライアントとして Iruka を動かすまでの作業を、時系列でそのまま残す。
うまくいった手順のまとめは [windows-client_JA.md](windows-client_JA.md)。

## 2026-10-16

### 環境

- Windows 11 24H2（ビルド 26100）。開発環境を Windows に移したが、入れたのは WSL2 と、その中の
  Claude Code だけ。
- Windows 側に最初からあったもの: Node.js v22.17.1、Visual Studio Community 2022 / 2019 と
  Build Tools 2019（C++ ツールあり）、WebView2 155、OpenSSH の `ssh.exe`、winget。
- なかったもの: Rust、Git for Windows、pkg-config、vcpkg。

### 方針: WSL では編集だけ、ビルドは Windows ネイティブ

- WSL 内でビルドすると Linux のバイナリになり、WSLg 上で動くだけで Windows クライアントの確認に
  ならない。
- そこで WSL の bash から `powershell.exe` / `cmd.exe` を呼び、Windows 側でビルドと実行をする。
- ソースは Windows のファイルシステムに置く（`\\wsl$` 越しのビルドは遅く、問題も起きやすい）。

### 手順 1: IronRDP のみのビルド

1. Rust: `winget install --id Rustlang.Rustup -e`。管理者権限は不要（ユーザー単位）。stable
   `x86_64-pc-windows-msvc`、cargo 1.99.1 が入った。
2. WSL から起動した Windows プロセスは、WSL 起動時の PATH を引き継ぐ。そのため `.cargo\bin` が
   PATH に入らない。`C:\Users\tosihide\Foundry\iruka-env.ps1` を作り、PATH の追加と作業フォルダへの
   移動をここにまとめた。
3. Git for Windows を入れずに済ませるため、WSL の git で `/mnt/c/Users/tosihide/Foundry/Iruka` に
   clone した。remote は `wsl`（WSL 側のリポジトリ）と `origin`（GitHub）の 2 つ。
4. `npm.cmd install`: OK。
5. `npm.cmd run build` の後、`cargo build --no-default-features --features ironrdp`: OK。7 分 08 秒、
   警告 4 件（FreeRDP 専用コードが未使用になるため）。
6. 起動 **失敗 1**: 手順書に書いていた `npm run tauri dev -- --no-default-features --features ironrdp`
   は `error: unexpected argument '--no-default-features'`。npm が `--` を取り除き、フラグが
   Tauri CLI に渡ってしまう。
7. 起動 **成功**: `.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features`
   （cargo のフラグは 2 つ目の `--` の後）。「Iruka」のウィンドウが開いた。起動直後のメモリは
   約 390 MB（`iruka_mem` の used_mb）。

### 手順 1 の動作確認（ユーザーが操作）

- **「+ Console」**: WSL の bash が開いた。
  - 原因: `pty.rs` は `$SHELL`、なければ `bash` を起動する。Windows には `$SHELL` がなく、`bash` は
    `C:\Windows\System32\bash.exe`（WSL の起動用）になる。作業フォルダも `$HOME` がないので
    ホームにならなかった。
  - 修正: Windows の代わりのシェルを `powershell.exe` にし、ホームは `%USERPROFILE%` も見るように
    した。`tauri dev` がファイルの変更を見て自動で再ビルドし（25 秒）、PowerShell が開くことを確認した。
  - ユーザーの意見: 自分は WSL の bash でもよいが、人によってはプロファイルを選べたほうがよい
    → TODO に追加。
- **「+ SSH」**: `ssh user@host` が入力され、そのまま接続できた。
- **「+ RDP」（IronRDP）で Ubuntu へ**: `Connection error (IronRDP): Connection failed: Session start:
  … decode error … other (received disconnect provider ultimatum)`。
  - 想定どおり。IronRDP は RDPGFX に対応しておらず、GNOME Remote Desktop が切断する。Windows 版
    特有の問題ではない（Linux 版でも同じ）。
  - 同じ接続先に、Windows 標準のリモート デスクトップ接続ではつながった。
- **IronRDP で Windows へ**: 後回し（接続先の Windows を別に用意してから）。
- commit `8db57e6`（`pty.rs` の修正、手順 1 の結果、TODO）。

### 手順 2: FreeRDP 3（vcpkg）

- FreeRDP 3 の開発用ライブラリ（ヘッダー、`.lib`、`.pc`）は Windows 向けに公式配布されていない
  → vcpkg でビルドする。
- vcpkg の `freerdp` ポートは **3.32.1**（Linux で使っているものと同じ）。feature は `client` /
  `ffmpeg` / `av1` / `server` / `urbdrc` / `winpr-tools` / `x11`（`x11` は Windows では使えない）。
  まずは `client` だけにする。
- WSL の git で `C:\Users\tosihide\Foundry\vcpkg` に clone し、`bootstrap-vcpkg.bat -disableMetrics`
  を実行（vcpkg 2026-09-26）。
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 9 パッケージ、合計 20 分
  （FreeRDP 本体 4.6 分）。エラーなし。`lib\pkgconfig` に `freerdp-client3.pc` など、`bin` に
  `freerdp3.dll` / `freerdp-client3.dll` / `winpr3.dll` / OpenSSL / zlib / cJSON の DLL、
  `tools\pkgconf\pkgconf.exe` が入った。
- `iruka-env.ps1` に追加: PATH に vcpkg の `bin`（実行時の DLL）と `tools\pkgconf`、
  `PKG_CONFIG=...\pkgconf.exe`、`PKG_CONFIG_PATH=...\lib\pkgconfig`。
  `pkgconf --cflags --libs freerdp-client3` が正しく解決することを確認した。
- ビルド **失敗 2**: `cargo build`（既定の feature）が `failed to remove file ...\iruka.exe` で止まった。
  手順 1 の `tauri dev` を WSL 側で止めても、Windows 側のプロセス（tauri.js / cargo / vite /
  iruka.exe）は残っていて、exe がロックされていた。`taskkill /T /F` で止めた。
  → WSL から起動したものは、WSL 側のジョブを止めても Windows 側では終わらない。
- ビルド **成功**: `build.rs` も `freerdp_bridge.c` も変更なし。pkg-config の仕組みがそのまま
  MSVC で動いた（25 秒。C コンパイラの警告は記録しそこねた）。
- 起動 **成功**: `.\node_modules\.bin\tauri.cmd dev`（既定の feature = freerdp,ironrdp）。DLL は
  vcpkg の `bin` を PATH に入れて読み込ませている（exe の横へのコピーはまだしていない）。

### 手順 2 の動作確認（ユーザーが操作）

- FreeRDP → Ubuntu（GNOME Remote Desktop）: **接続できた**。
- クリップボード: 双方向のコピー＆ペースト OK。
- 一覧表示、Tab でのセッション移動、選択して拡大表示: OK。
- メモリ: `iruka_mem` の used_mb が約 1024（セッション 2 本、pixels = 2 × 1920×1080）、baseline 388。

### ログで見つけたこと: md4 / rc4 がない

- 接続時の FreeRDP の警告: `md4: NTLM support not available`、
  `rc4: … NTLM and autoreconnect cookies will not work`、`rc4: RDP licensing and RDP security will not work`。
- OpenSSL 3 の legacy プロバイダーを疑った。vcpkg の `libcrypto-3-x64.dll` を `strings` で見ると
  `MODULESDIR: "C:\Program Files\OpenSSL\bin"`。`legacy.dll` は vcpkg の `bin` にある。確定。
- `iruka-env.ps1` に `OPENSSL_MODULES=<vcpkg>\bin` を追加した。警告が消えるか、Windows の接続先に
  NTLM でつながるかはまだ確認していない。KNOWN_ISSUES_JA.md に記録した。
- ほかの警告は想定どおりのもの（コマンドラインの `/p`、`/cert:ignore`）。

### 音声テスト（Ubuntu、Audio と Microphone をオン、2 回接続）

- `OPENSSL_MODULES` を設定して起動し直した: md4 / rc4 の警告は**消えた**。
- マイク: ローカルのマイクがリモートに届いた。OK。
- 音声の再生: 音は**リモート側で**鳴ったまま、ローカルでは鳴らなかった。今回はログに rdpsnd の行が
  1 行もなく、どの出力先が使われたか分からない（前回の「Loaded fake backend for rdpsnd」は Audio
  オフのとき。Iruka は `/audio-mode:2` を渡すので想定どおり）。
- Windows 版特有かどうかは未確定: GNOME Remote Desktop での音声は Linux 版からも確かめていない
  （TODO）。vcpkg の FreeRDP は `WITH_WINMM=ON` でビルドされている。

### 接続先が Windows（FreeRDP）

- 3840×2160 の Windows に NLA でつながった。`OPENSSL_MODULES` を設定すれば NTLM は動く。
  1 回だけ `ERRCONNECT_LOGON_FAILURE`（サーバーがログオンを拒否。パスワードの打ち間違いと思われる）、
  次の試行でつながった。
- 音声はローカルで鳴り、マイクはリモートに届き、クリップボードは双方向で動いた。
- **上の Ubuntu 音声テストの訂正**: FreeRDP のログは遅れて出ていた（バッファリング）。出そろってみると、
  Ubuntu の 2 回の接続でも `Loaded winmm backend for rdpsnd`（static と dynamic）と
  `Loaded winmm backend for audin` が出ていた。クライアント側は正常なので、音が Ubuntu 側で鳴ったまま
  なのは GNOME Remote Desktop 側の振る舞いと思われる。Windows クライアントの問題ではなさそう。
- メモリ（`iruka_mem` の used_mb。Linux との比較は docs/code-notes_JA.md「メモリモデル」）: セッションなしで 393。1920×1080 の
  Ubuntu 1 本で約 760〜780。そのセッションを閉じた後も約 1,010（戻らない）。3840×2160 の
  Windows 1 本で約 1,580〜1,630。

### 接続先 Windows（IronRDP）と残りの UI 確認

- IronRDP → Windows: 接続できた。
- IronRDP では音声の再生とマイクは動かない。想定どおり: Iruka が音声、マイク、Low memory、
  クリップボードをつないでいるのは FreeRDP だけ（README）。ユーザーの意見: IronRDP 自体がまだ
  実装途上なので、「experimental」扱いでよいかもしれない。
- 右 Alt の表示切り替え: 動いた（ここでは日本語配列。AltGr になる配列は試していない）。
- 全画面と、上部中央のドロップダウンのツールバー: 動いた。

### ポータブル zip（ユーザー自身が使う用）

- `src-tauri/src/lib.rs`: Windows では起動時に、`legacy.dll` が exe のフォルダーにあり変数が未設定なら、
  `OPENSSL_MODULES` をそのフォルダーにする。
- 編集した `lib.rs` を Windows 側の clone にコピーしたら、動いていた `tauri dev` が再ビルドして Iruka を
  再起動し、開いていたセッションが切れた。→ Windows 側の clone に触る前に `tauri dev` を止める。
- `tauri.cmd build --no-bundle`: 9 分 50 秒。zip は `C:\Users\tosihide\Foundry\dist` にまとめた。
- 動作確認: vcpkg のフォルダーを PATH に入れていない PowerShell から起動して、ウィンドウが開いた
  （exe の横の DLL が読み込まれた）。
- ユーザーが zip を `C:\Tmp` にコピーして展開し、そこから `iruka.exe` を起動: 警告なし（この PC で
  作った zip なので Mark of the Web が付いていない）。Windows の接続先に NLA でつながり、音声も
  ローカルで鳴った。起動時の `OPENSSL_MODULES` の設定が、環境の準備なしで効いている。

### SignPath Foundation（OSS 向けの無料署名）、規約を確認

- 条件: すべての部品が OSI ライセンス、活発にメンテナンスされ既にリリースしていること、リポジトリから
  検証できる形でビルドすること（CI）、チーム全員の多要素認証、役割（作者、レビュアー、承認者）の定義、
  プロジェクトのページに「Code signing policy」の節、リリースごとの手動承認。Windows に出る発行元は
  「SignPath Foundation」。
- 利用者数の下限は書かれていないが、実行ファイルには「検証できる一定の評判」を求め、最初の審査は人が
  行い、受け入れるかどうかは SignPath の裁量。公開したばかりで一人で使っているツールは、今はまず
  通らない見込み。

### まとめを作成

- [windows-client_JA.md](windows-client_JA.md) を、うまくいった手順のまとめとして書き直した。

## 2026-10-26: ネイティブ PowerShell 構成

### 環境

- 新しく入れた Windows 11 Pro（ビルド 26200）で同じことをした。今回は WSL ではなく、PowerShell で
  Windows 版 Claude Code を動かす。オーナーが Git for Windows、Node 26.12、rustup（stable MSVC）、
  Visual Studio Community 2026（18.11）の C++ ワークロードを入れ、`C:\Users\tosihide\Iruka` に clone 済み。
- 足りなかったもの: vcpkg、FreeRDP、環境スクリプト、`node_modules`。

### 手順

- vcpkg を `C:\Users\tosihide\Foundry\vcpkg` に clone して bootstrap（前回と同じ場所なので、ドキュメントの
  パスはそのまま。vcpkg ツール 2026-09-26）。
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 合計 32 分（Strawberry Perl、NASM、
  jom は vcpkg が自分で取ってくるので、他に入れるものはない）。FreeRDP は 3.32.2 になった。
- `C:\Users\tosihide\Foundry\iruka-env.ps1` をドキュメントの内容で作り直した。
- `npm install`: npm 11 は esbuild の postinstall について「not yet covered by allowScripts」と警告して
  実行しない。問題なし。`tsc` と `npm run build` は通る。
- VS 2026 で動く: FreeRDP + IronRDP の `cargo build` が通る（IronRDP のみの初回ビルドは 8.5 分）。
- `cargo test`: `rdp::tests::detects_own_addresses` が `is_local_host("", 3389)` で失敗。Windows は空の名前を
  自分のアドレスに解決するので、ホスト欄が空だと「この PC」と判定されていた。
  `src-tauri/src/rdp/mod.rs` を修正（空のホストはローカルではない）。
- keyring の往復テスト（`cargo test -- --ignored credentials`）は Windows の資格情報マネージャーで通る。
- docs/windows-client_JA.md に「開発の 2 つのやり方」（ネイティブ PowerShell と WSL から）を追加。
### 起動直後のワークセット復元が失敗する（修正済み）

- 起動直後にワークセット（RDP 6 + SSH 5）を復元すると、RDP がすべて約 70 ms で
  `getaddrinfo(10.0.1.112) failed` → `ERRCONNECT_DNS_NAME_NOT_FOUND` で失敗した。ホストは IP アドレス。
  「Saved」から 1 つずつ開くとつながるので、最初は負荷で TCP が失敗していると見えた。
- 原因: Windows ではプロセスが `WSAStartup` を呼ぶまで Winsock の呼び出しはすべて失敗する。FreeRDP は
  これをアプリに任せている（wfreerdp は `main` で呼ぶ）。手で接続すると先に「この PC か」の確認
  （`rdp_is_self`）が走り、その Rust の `std::net` がプロセス全体の Winsock を開始していた。復元では
  この確認を通らない。
- 修正: `native/freerdp_bridge.c` の `iruka_rdp_new` で、Windows では `WSAStartup(2.2)` を呼ぶ（参照
  カウントなのでセッションごとに呼んでよい）。FreeRDP のヘッダーより前に `<winsock2.h>` を入れると
  `freerdp/rail.h` が壊れた（C2059）。後ろで `<winpr/winsock.h>` を入れれば通る。確認: 起動直後の復元で
  RDP 6 本ともつながった。
- 同じ日に追加: ツールバーのメモリ表示、Print Screen ボタンを左端へ移動（README）。