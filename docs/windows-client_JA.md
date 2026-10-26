*English: [windows-client.md](windows-client.md)*

# Windows で Iruka を動かす（クライアント側）

状態: **FreeRDP で動作**（2026-10-16、Windows 11 24H2 ビルド 26100、開発ビルド）。
vcpkg の FreeRDP 3.32.1 で Ubuntu（GNOME Remote Desktop）に接続できた。`build.rs` と C ブリッジの
変更は不要だった。接続先が Windows でもつながった（NLA、音声、マイク、クリップボード）。IronRDP でも Windows につながった。まだ試していないもの: インストーラー。
試行錯誤を含む経緯は [windows-client-log_JA.md](windows-client-log_JA.md)。

## 前提

| 何を | どうやって | メモ |
| --- | --- | --- |
| Visual Studio の C++ ツール | 「C++ によるデスクトップ開発」（Build Tools で足りる） | C ブリッジのコンパイルとリンクに MSVC を使う。最初は 2022、Community 2026（18.11）でも動く（2026-10-26） |
| WebView2 | Windows 11 には入っている | |
| Node.js | 22 と 26 を使った | |
| Rust | `winget install --id Rustlang.Rustup -e` | ユーザー単位、管理者権限不要。stable `x86_64-pc-windows-msvc` |
| vcpkg | `git clone https://github.com/microsoft/vcpkg.git` の後 `bootstrap-vcpkg.bat -disableMetrics` | |
| FreeRDP 3 | `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"` | 初回 20 分。FreeRDP 3.32.1 |
| `ssh.exe` | 最初から入っている（OpenSSH クライアント） | 「+ SSH」で使う |
| Git | Git for Windows（ネイティブ構成）、または WSL の git（WSL 構成） | |
| スマート アプリ コントロールをオフ | Windows セキュリティ → アプリとブラウザーの制御 | オンのままだとビルドした `iruka.exe` が止められる（os error 4551）。KNOWN_ISSUES_JA.md 参照 |

## 開発の 2 つのやり方

どちらもビルドは Windows ネイティブ。違うのはシェル（と Claude Code）をどこで動かすか。

| | ネイティブ（PowerShell） | WSL から |
| --- | --- | --- |
| シェル、Claude Code | PowerShell、Windows 版 Claude Code | WSL の bash、Linux 版 Claude Code |
| clone | Windows のファイルシステムのどこでも。例: `%USERPROFILE%\Iruka` | Windows のファイルシステム上。例: `%USERPROFILE%\Foundry\Iruka`（WSL からは `/mnt/c/...`） |
| Git | Git for Windows | WSL の git |
| ビルドのコマンド | 環境スクリプトを読み込んでから直接実行 | `powershell.exe` 経由。[WSL から開発する](#wsl-から開発する) 参照 |

下の前提、vcpkg、環境スクリプトは共通で、vcpkg は 1 つで両方に使える。同じ clone を両方の構成で
同時にビルドしないこと（`src-tauri\target` を共有するため）。

## 環境変数

Iruka をビルド・実行する PowerShell では毎回これが必要（vcpkg を `%USERPROFILE%\Foundry\vcpkg` に
置いた場合。スクリプトにして `. ` で読み込む）:

```powershell
$vcpkg = "$env:USERPROFILE\Foundry\vcpkg\installed\x64-windows"
$env:Path = "$env:USERPROFILE\.cargo\bin;$vcpkg\bin;$vcpkg\tools\pkgconf;" + $env:Path
$env:PKG_CONFIG = "$vcpkg\tools\pkgconf\pkgconf.exe"   # ビルド: build.rs は pkg-config で FreeRDP を探す
$env:PKG_CONFIG_PATH = "$vcpkg\lib\pkgconfig"
$env:OPENSSL_MODULES = "$vcpkg\bin"                    # 実行: OpenSSL の legacy プロバイダー。KNOWN_ISSUES_JA.md 参照
```

`Path` に `$vcpkg\bin` を入れることで、実行時に `iruka.exe` が `freerdp3.dll`、`freerdp-client3.dll`、
`winpr3.dll`、OpenSSL / zlib / cJSON の DLL を見つけられる。

## ビルドと実行

ネイティブの PowerShell で、clone したフォルダーから:

```powershell
. $env:USERPROFILE\Foundry\iruka-env.ps1
npm install
.\node_modules\.bin\tauri.cmd dev                                            # FreeRDP + IronRDP（既定）
.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features # IronRDP のみ。vcpkg 不要
```

- cargo のフラグは 2 つ目の `--` の後に書く。`npm run tauri dev -- --no-default-features` は動かない
  （npm がフラグを Tauri CLI に渡し、CLI が受け付けない）。
- 初回のビルドは約 7 分。2 回目以降は 25〜60 秒。
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

その後、vcpkg の `installed\x64-windows\bin` から `freerdp3.dll`、`freerdp-client3.dll`、`winpr3.dll`、
`libcrypto-3-x64.dll`、`libssl-3-x64.dll`、`legacy.dll`、`z.dll`、`cjson.dll` を `iruka.exe` の横に置き
（`pkgconf-8.dll` と `.pdb` は不要）、`LICENSE.txt` と短い `README.txt` を添えてフォルダーごと zip にする。
2026-10-16: 展開後 26 MB、zip で 9.7 MB。

Windows では起動時に、`legacy.dll` が同じフォルダーにあり `OPENSSL_MODULES` が未設定なら、Iruka が
自分のフォルダーをこの変数に設定する（`src-tauri/src/lib.rs`）。設定なしで NTLM が動く（2026-10-16 確認:
別のフォルダーに展開して Windows の接続先につながり、音声もローカルで鳴った）。

## WSL から開発する

WSL 内の Claude Code から Windows のビルドを動かせる（2026-10-16 の構成）:

- ビルドは Windows ネイティブで行う。WSL 内でビルドすると Linux のバイナリになり、WSLg 上で
  動くだけになる。
- clone は Windows のファイルシステムに置く（例: `C:\Users\<user>\Foundry\Iruka`。WSL からは
  `/mnt/c/Users/<user>/Foundry/Iruka`）。そこでは WSL の git が使えるので、Git for Windows はなくてもよい。
- bash から `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '. <環境スクリプト>; …'` で呼ぶ。
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
