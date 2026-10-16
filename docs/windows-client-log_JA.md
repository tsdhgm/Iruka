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

### まとめを作成

- [windows-client_JA.md](windows-client_JA.md) を、うまくいった手順のまとめとして書き直した。
