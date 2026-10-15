*English: [windows-client.md](windows-client.md)*

# Windows で Iruka を動かす（クライアント側）

状態: **未着手**（2026-10-15、最初の試行の前にリポジトリから書き起こした手順）。
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
npm run tauri dev -- --no-default-features --features ironrdp
```

期待する結果: ウィンドウが開く。「+ Console」で PowerShell / cmd のコンソールが開く（portable-pty は
ConPTY を使う）。「+ SSH」で ssh コマンドが打ち込まれる。「+ RDP」で Backend を「IronRDP」にすると
Windows の接続先につながる（音声・マイク・クリップボードはなし。GNOME Remote Desktop は IronRDP に
RDPGFX がないので拒否される。KNOWN_ISSUES_JA.md 参照）。

Windows で特に確認すること:

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
