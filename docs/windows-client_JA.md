*English: [windows-client.md](windows-client.md)*

# Windows で Iruka を動かす（クライアント側）

状態: **FreeRDP で動作**（2026-10-16、Windows 11 24H2 ビルド 26100、開発ビルド）。
vcpkg の FreeRDP 3.32.1 で Ubuntu（GNOME Remote Desktop）に接続できた。`build.rs` と C ブリッジの
変更は不要だった。接続先が Windows でもつながった（NLA、音声、マイク、クリップボード）。IronRDP でも Windows につながった。まだ試していないもの: インストーラー。
試行錯誤を含む経緯は [windows-client-log_JA.md](windows-client-log_JA.md)。

## 前提

| 何を | どうやって | メモ |
| --- | --- | --- |
| Visual Studio の C++ ツール | 「C++ によるデスクトップ開発」（Community または Build Tools） | C ブリッジのコンパイルとリンクに MSVC を使う。最初は 2022、Community 2026 でも動く |
| vcpkg | 下の [vcpkg](#vcpkg) 参照 | `vcpkg.json` から FreeRDP 3 とそのライブラリをビルドする |
| WebView2 | Windows 11 には入っている | |
| PowerShell でスクリプトの実行を許可 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force` を一度だけ | ユーザー単位、管理者不要、以後のどのウィンドウにも効く。Windows は既定で `.ps1` を実行しないので、`npm`（`npm.ps1`）も `. scripts\windows-env.ps1` も「running scripts is disabled on this system」で止まる。`Get-ExecutionPolicy` で確認。設定を残したくなければ、ウィンドウを開くたびに `Set-ExecutionPolicy -Scope Process Bypass -Force` |
| Node.js | `winget install --id OpenJS.NodeJS.LTS -e`（nodejs.org 公式の MSI） | 24 以降。22、24、26 を使った。全ユーザー向けで、管理者の承認を一度求められる。入れるのはこれ 1 つだけ（nvm-windows / Chocolatey / Scoop / Store の Node.js を併用しない）。新しい PowerShell で `node -v` で確認 |
| Rust | `winget install --id Rustlang.Rustup -e`（または rustup.rs の rustup-init.exe） | ユーザー単位、管理者権限不要。このコマンド 1 つで stable の `x86_64-pc-windows-msvc` ツールチェーンも入り、別にインストールするものはない（新しい PowerShell で `rustup show` で確認） |
| `ssh.exe` | 最初から入っている（OpenSSH クライアント） | 「+ SSH」で使う |
| Git | Git for Windows（ネイティブ構成）、または WSL の git（WSL 構成） | vcpkg も Git を使う |
| スマート アプリ コントロールをオフ | Windows セキュリティ → アプリとブラウザーの制御 | オンのままだとビルドした `iruka.exe` が止められる（os error 4551）。KNOWN_ISSUES_JA.md 参照 |

Visual Studio を `Path` に通す必要はなく、インストール後の再起動も要らない。cargo と
`scripts\windows-deps.ps1` は `vswhere.exe` で Visual Studio を見つける。

## vcpkg

Iruka は vcpkg を**マニフェスト モード**で使う。リポジトリ直下の `vcpkg.json` がライブラリ
（`freerdp[client]`、`pkgconf`）を挙げ、`builtin-baseline` でバージョンを固定する。ライブラリは clone の
中の `vcpkg_installed\x64-windows\` にビルドされる（git では無視）。vcpkg はどれでもよく、見つかれば動く:

1. **すでに Visual Studio で開発している人。** 自分で clone した microsoft/vcpkg があれば `VCPKG_ROOT` を
   そこに向ける（Developer PowerShell も設定する）。`vcpkg.json` の baseline より古ければ先に `git pull`
   する。なければ Visual Studio 付属の vcpkg を使う。Visual Studio Installer → 変更 → 個別のコンポーネント
   で「vcpkg パッケージ マネージャー」が入っていなければチェックを入れる（以前に入れた Community 2022 には
   入っていないことがある）。
2. **Iruka のために初めてビルド環境を入れる人。** Visual Studio Community 2026 を「C++ によるデスクトップ
   開発」で既定の選択のまま入れる。これに「vcpkg パッケージ マネージャー」が含まれる（2026-11-18 に確認）。
   ほかに何もしなくてよい。

そのあと clone から実行する（初回 10〜20 分）:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows-deps.ps1
```

スクリプトは `-Vcpkg <vcpkg.exe のパス>`、なければ `$env:VCPKG_ROOT\vcpkg.exe`、なければ Visual Studio
付属のものを使う。Visual Studio 付属の vcpkg にはクラシック モードがない（マニフェストの外で
`vcpkg install <port>` とすると "this vcpkg instance requires a manifest" で失敗する）。リポジトリが
`vcpkg.json` を持つのはこのため。ライブラリを新しい版に上げるときは、clone で `vcpkg x-update-baseline`
を実行し、変わった `vcpkg.json` をコミットする。

## 開発の 2 つのやり方

どちらもビルドは Windows ネイティブ。違うのはシェル（と Claude Code）をどこで動かすか。

| | ネイティブ（PowerShell） | WSL から |
| --- | --- | --- |
| シェル、Claude Code | PowerShell、Windows 版 Claude Code | WSL の bash、Linux 版 Claude Code |
| clone | Windows のファイルシステムのどこでも。例: `C:\src\iruka` | Windows のファイルシステム上。ネイティブ構成と同じ clone でもよい（WSL からは `/mnt/c/src/iruka`） |
| Git | Git for Windows | WSL の git |
| ビルドのコマンド | 環境スクリプトを読み込んでから直接実行 | `powershell.exe` 経由。[WSL から開発する](#wsl-から開発する) 参照 |

前提、`vcpkg_installed` のライブラリ、環境スクリプトは共通。同じ clone を両方の構成で同時にビルド
しないこと（`src-tauri\target` を共有するため）。

## 環境変数

Iruka をビルド・実行する PowerShell では毎回、vcpkg のライブラリを `Path` に通し、いくつかの変数を設定
する必要がある。`scripts\windows-env.ps1` がそれを clone からの相対パスで行うので、`. ` で読み込む:

```powershell
. scripts\windows-env.ps1
```

「cannot be loaded because running scripts is disabled on this system」と出たら、PowerShell で
まだスクリプトの実行が許可されていない。前提の「PowerShell でスクリプトの実行を許可」を参照。

設定する内容（`$v` は `<clone>\vcpkg_installed\x64-windows`）: `Path` に `$v\bin` と `$v\tools\pkgconf`
（`$v\bin` により、実行時に `iruka.exe` が `freerdp3.dll`、`freerdp-client3.dll`、`winpr3.dll`、
OpenSSL / zlib / cJSON の DLL を見つけられる）。`build.rs` が FreeRDP を見つけるための `PKG_CONFIG` と
`PKG_CONFIG_PATH`。NTLM 用の OpenSSL legacy プロバイダーを指す `OPENSSL_MODULES`（KNOWN_ISSUES_JA.md）。

## ビルドと実行

ネイティブの PowerShell で、clone したフォルダーから:

```powershell
. scripts\windows-env.ps1
npm install
.\node_modules\.bin\tauri.cmd dev                                            # FreeRDP + IronRDP（既定）
.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features # IronRDP のみ。vcpkg 不要
```

- cargo のフラグは 2 つ目の `--` の後に書く。`npm run tauri dev -- --no-default-features` は動かない
  （npm がフラグを Tauri CLI に渡し、CLI が受け付けない）。
- 初回のビルドは約 7 分。2 回目以降は 25〜60 秒。
- clone を移動したり名前を変えたりしたら、`src-tauri` で一度 `cargo clean` する。Tauri のビルドスクリプトは
  古い `target` フォルダーへの絶対パスを覚えているので、次のビルドが `failed to read plugin permissions:
  failed to read file '\\?\C:\<古いパス>\src-tauri\target\…\app_hide.toml'` で失敗する。
- **起動直後に赤字で出る `NativeCommandError` / `RemoteException` は問題ない。** `2>&1` を付けると
  （たとえば `Tee-Object` でログを残すとき）、Windows PowerShell 5.1 は外部プログラムが stderr に書いた
  各行をエラーレコードに包み、最初の 1 行を赤字で `At line:1 char:…`、
  `CategoryInfo : NotSpecified: (… Running BeforeDevCommand (`npm run dev`) …) [], RemoteException`、
  `FullyQualifiedErrorId : NativeCommandError` と表示する。「Exception（例外）」「Error」という言葉が
  あっても、何も失敗していない。Tauri と cargo が進行状況（「Running …」「Compiling …」「Finished …」）を
  stderr に書いているだけで、メッセージの本体は括弧の中にある。`RemoteException` は PowerShell が
  「別のプログラムの stderr から来た文字列」に付ける名前にすぎない。表示を消したければ、合流を cmd に
  任せる。ログにはすべて残る:

  ```powershell
  [Console]::OutputEncoding = [Text.Encoding]::UTF8   # 任意: これがないと vite の「➜」が「Ô×£」と化ける
  cmd /c ".\node_modules\.bin\tauri.cmd dev 2>&1" | Tee-Object -FilePath $env:USERPROFILE\iruka-dev.log
  ```

  PowerShell 7（`pwsh`）はこの包み込みをしない。
- npm 11 以降は esbuild の postinstall スクリプトについて「not yet covered by allowScripts」と警告し、
  実行しない。問題はない: esbuild の実行ファイルは `@esbuild/win32-x64` パッケージから入り、
  `npm run build` は動く。

## ポータブル zip

開発環境なしで使うため（署名なし。配布の方針は TODO_JA.md）:

```powershell
.\node_modules\.bin\tauri.cmd build --no-bundle   # src-tauri\target\release\iruka.exe。フロントエンドを埋め込み（約 10 分）
```

その後、`powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1` で全部を集めて
`release\iruka-<version>-windows-x64.zip` にする（2026-10-26 から。FreeRDP と OpenSSL の著作権表示ファイルも
入れる）。手作業でやる場合の中身: `vcpkg_installed\x64-windows\bin` から `freerdp3.dll`、`freerdp-client3.dll`、`winpr3.dll`、
`libcrypto-3-x64.dll`、`libssl-3-x64.dll`、`legacy.dll`、`libz.dll`（vcpkg の zlib 1.4 より前は `z.dll`）、`cjson.dll` を `iruka.exe` の横に置き
（`pkgconf-8.dll` と `.pdb` は不要）、`LICENSE.txt` と短い `README.txt` を添えてフォルダーごと zip にする。
2026-10-16: 展開後 26 MB、zip で 9.7 MB。

Windows では起動時に、`legacy.dll` が同じフォルダーにあり `OPENSSL_MODULES` が未設定なら、Iruka が
自分のフォルダーをこの変数に設定する（`src-tauri/src/lib.rs`）。設定なしで NTLM が動く。これが実際に
効くのは 2026-10-26 から。それまでは OpenSSL から見えないやり方で設定していて、zip から接続すると
`OpenSSL LEGACY provider failed to load` が出ていた（KNOWN_ISSUES_JA.md）。変更後の確認: 展開した
フォルダーから `OPENSSL_MODULES` なしで接続し、ログに `LEGACY` / `md4` / `rc4` の行がないこと。

## WSL から開発する

WSL 内の Claude Code から Windows のビルドを動かせる（2026-10-16 の構成）:

- ビルドは Windows ネイティブで行う。WSL 内でビルドすると Linux のバイナリになり、WSLg 上で
  動くだけになる。
- clone は Windows のファイルシステムに置く（例: `C:\src\iruka`。WSL からは `/mnt/c/src/iruka`）。
  そこでは WSL の git が使えるので、Git for Windows はなくてもよい。Windows のパスは大文字と小文字を
  区別しないので、`C:\src\Iruka` と `C:\src\iruka` は同じフォルダー（WSL 側では別の綴りになる）。
- bash から `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '. scripts\windows-env.ps1; …'` で呼ぶ。
  WSL から起動した Windows プロセスは WSL 起動時の PATH を引き継ぐので、後から入れた Rust は PATH に
  入っていない。環境スクリプトで補う。
- WSL 側のジョブを止めても、そこから起動した Windows のプロセス（tauri / vite / cargo / `iruka.exe`）
  は止まらない。Iruka のウィンドウを閉じるか、`taskkill /T /F /PID <tauri.js の pid>` で止める。
  そうしないと次のビルドが `failed to remove file ...\iruka.exe` で失敗する。

## 確認したこと（2026-10-16）

| 機能 | 結果 |
| --- | --- |
| ウィンドウ、UI | OK |
| 「+ Console」 | ユーザーフォルダで PowerShell が開く（`pty.rs` を修正した後。`SHELL` を設定すれば優先。例: `SHELL=wsl.exe`） |
| 「+ SSH」 | `ssh.exe` で OK |
| FreeRDP → Ubuntu（GNOME Remote Desktop） | OK |
| クリップボード（テキスト）の双方向 | OK |
| 一覧表示、Tab での移動、選択して拡大表示 | OK |
| マイク → Ubuntu | OK |
| Ubuntu の音声の再生 | WinMM の出力先は読み込まれるが、音はリモート側で鳴ったまま。GNOME Remote Desktop 側の振る舞いと思われる。Linux 版との比較はまだ |
| FreeRDP → Windows（3840×2160、NLA / NTLM） | OK |
| 接続先 Windows での音声、マイク、クリップボード | OK（音はローカルで鳴り、マイクはリモートに届き、クリップボードは双方向） |
| IronRDP → Windows | OK（音声・マイクはなし。Linux 版と同じく FreeRDP にしかつないでいない） |
| 右 Alt の表示切り替え | OK（日本語配列。AltGr になる配列は試していない） |
| 全画面、ドロップダウンのツールバー | OK |
| IronRDP → Ubuntu | 拒否される。Linux 版と同じ（IronRDP に RDPGFX がない） |
| メモリ（`iruka_mem`） | セッションなしで約 390 MB、1920×1080 を 2 本で約 1.0 GB、3840×2160 を 1 本で約 1.6 GB。セッションを閉じても戻らない（Linux との比較はまだ） |

## まだ確認していないこと

- 右 Alt が AltGr になる配列での表示切り替え。
- インストーラー: FreeRDP / OpenSSL の DLL（`legacy.dll` を含む）を `iruka.exe` の横に同梱し
  （Tauri 設定の `bundle.resources`）、`OPENSSL_MODULES` をそこに向ける必要がある。Iruka 自身が
  起動時に設定するのがよさそう。
- vcpkg の `ffmpeg` feature を足す価値があるか（H.264 / AVC444 のデコード）。
