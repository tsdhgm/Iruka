*English: [windows-client.md](windows-client.md)*

# Windows で Iruka を動かす（クライアント側）

試行錯誤を含む作業記録: [windows-client-log_JA.md](windows-client-log_JA.md)。

状態: **手順 1 は動作**（2026-10-16、Windows 11 24H2 ビルド 26100）。手順 2（FreeRDP）は作業中。
実際にやった結果でこのファイルを更新すること。

## 前提

- Windows の Tauri 2: Microsoft Visual Studio C++ Build Tools（C++ によるデスクトップ開発）、
  WebView2 ランタイム（Windows 11 には入っている）、Rust（MSVC ツールチェーン、`rustup`）、Node.js。
  https://v2.tauri.app/start/prerequisites/ を参照。
- OpenSSH クライアント（`ssh.exe`）。Windows 10/11 には標準で入っている。「+ SSH」がコンソールに
  `ssh user@host` を打ち込むのに使う。
- Git。

## 手順 1: FreeRDP なしでビルドする（純 Rust）

C ブリッジには Windows に標準で入っていない FreeRDP 3 が要る。まず、それ以外（Tauri、WebView2、
PTY のコンソール、UI）が動くことを確かめる:

```powershell
git clone https://github.com/tsdhgm/Iruka.git
cd Iruka
npm install
.\node_modules\.bin\tauri.cmd dev --features ironrdp -- --no-default-features
```

期待する結果: ウィンドウが開く。「+ Console」で PowerShell / cmd のコンソールが開く（portable-pty は
ConPTY を使う）。「+ SSH」で ssh コマンドが打ち込まれる。「+ RDP」で Backend を「IronRDP」にすると
Windows の接続先につながる（音声・マイク・クリップボードはなし。GNOME Remote Desktop は IronRDP に
RDPGFX がないので拒否される。KNOWN_ISSUES_JA.md 参照）。

Windows で特に確認すること:

### 結果（2026-10-16）

環境: リポジトリの編集は WSL 内の Claude Code から行い、ビルドと実行は Windows ネイティブで行った
（WSL 内でビルドすると Linux のバイナリになる）。Rust は `winget install Rustlang.Rustup` で入れた
（ユーザー単位、stable `x86_64-pc-windows-msvc`）。Node.js 22、Visual Studio 2022 の C++ ツール、
WebView2、`ssh.exe` は最初から入っていた。clone 先は `C:\Users\<user>\Foundry\Iruka`
（WSL の git で clone。Git for Windows は不要）。初回の `cargo build` は約 7 分、警告は 4 件
（FreeRDP 専用コードが未使用になるため）。

- `npm run tauri dev -- --no-default-features …` は動かない。npm がこのフラグを Tauri CLI に渡し、
  CLI が受け付けない。cargo のフラグは上のコマンドのように 2 つ目の `--` の後に書く。
- ウィンドウ、UI: OK。
- 「+ Console」: 最初は WSL の bash が開いた。Windows には `$SHELL` がなく、代わりの `bash` が
  `System32\bash.exe`（WSL の起動用）になったため。作業フォルダもホームにならなかった（`$HOME` がない）。
  `src-tauri/src/pty.rs` で修正: 代わりのシェルを `powershell.exe` にし、ホームは `%USERPROFILE%` も
  見るようにした。`SHELL` を設定すれば（例: `SHELL=wsl.exe`）そちらが優先される。
- 「+ SSH」: OK。`ssh.exe` で接続できた。
- IronRDP で Ubuntu（GNOME Remote Desktop）へ「+ RDP」: 想定どおり拒否された（IronRDP に RDPGFX が
  ない。エラーの末尾は "received disconnect provider ultimatum"）。同じ接続先に Windows 標準の
  リモート デスクトップ接続ではつながる。
- IronRDP で Windows の接続先へ: 未確認（接続先の Windows を別に用意する）。

まだ確認していないこと:

- 表示切り替えキー（右 Alt）とウィンドウ全体のキー監視は GNOME / Wayland でしか試していない。
  Windows では配列によって右 Alt が AltGr になる。
- 全画面（`setFullscreen`）と、上から降りるツールバー。
- メモリ確認: `sysinfo` は Windows に対応。モデルのファイルは Tauri のアプリデータの場所に入る。
- クリップボード: `arboard` は Windows に対応。

## 手順 2: FreeRDP 3 を足す

`src-tauri/build.rs` は `pkg-config`（`freerdp-client3`）で FreeRDP を探し、`native/freerdp_bridge.c` を
`cc` クレートでコンパイルする。Windows での選択肢:

1. **vcpkg**（MSVC ツールチェーンならこれ）: vcpkg で `freerdp` を入れ、`pkg-config` で見つかるように
   する。vcpkg の `pkgconf` も入れ、`PKG_CONFIG_PATH` を `<vcpkg>/installed/x64-windows/lib/pkgconfig`
   に向ける。`pkg-config` クレートは `pkg-config` / `pkgconf` の実行ファイルが `PATH` にあること
   （または `PKG_CONFIG` で指すこと）も必要。
2. **FreeRDP をソースからビルド**（CMake + MSVC）し、`.pc` ファイルを同じ方法で用意する。
3. **MSYS2** にも FreeRDP のパッケージがあるが MinGW 版で、MSVC でビルドした Rust とはリンクできない。
   `x86_64-pc-windows-gnu` の Rust ツールチェーンと組み合わせるときだけ使えるが、Tauri は推奨していない。

そのうえで既定の構成でビルドする:

```powershell
npm run tauri dev
```

リポジトリ側で変更が要るかもしれない点:

- `build.rs`: Windows で `pkg-config` が面倒なら、`FREERDP_DIR` でインクルードとライブラリの場所を
  直接指定する逃げ道を足す（`cargo:rustc-link-search`、`cargo:rustc-link-lib=freerdp-client3` など）。
  Linux の pkg-config の経路は残す。
- ブリッジは Linux の FreeRDP 3.32 に合わせて書いてある。WinPR のヘッダーと `CRITICAL_SECTION` の
  使い方が MSVC で通るか確かめる（WinPR は Win32 を模しているので通るはず）。
- 実行時には FreeRDP の DLL が `iruka.exe` の隣に必要（vcpkg の `bin` からコピー）。インストーラーを
  作るなら Tauri の `bundle.resources` に列挙する。
- 音声: `/sound` と `/microphone` は FreeRDP の Windows 用の音声バックエンドを使う。確認が要る。

## 手順 3: 結果を残す

- 実際に通ったコマンドと加えた変更で、このファイル（と `windows-client.md`）を更新する。
- FreeRDP や Windows 固有で動かないものは KNOWN_ISSUES_JA.md に書く。
- 終わったら TODO_JA.md の「クライアントの Windows ビルド」にチェックを付ける。
