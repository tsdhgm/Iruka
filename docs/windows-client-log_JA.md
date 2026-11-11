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
### スマート アプリ コントロール、リリースビルド、ポータブル zip

- スマート アプリ コントロールがオンのままだと、リリースビルドが `error[E0463]: can't find crate for
  asn1_rs_derive` で失敗した。イベント ビューアー → CodeIntegrity → Operational にイベント 3033/3077:
  `rustc.exe` がビルドしたばかりの手続き型マクロの DLL `asn1_rs_derive-….dll` を読み込むのを拒まれていた
  （「Enterprise signing level requirements を満たさない」）。同じ日の朝、開発ビルドの `iruka.exe` は最初
  止められ、後で動いた。判定はクラウドの評判サービスから来るので一定しない。オーナーがスマート アプリ
  コントロールをオフにし、リリースビルドは通った（10 分 51 秒）。
- `scripts/make-zip.ps1` を追加（リリースの exe、vcpkg の DLL 8 個、LICENSE、FreeRDP と OpenSSL の著作権
  表示、README を集めて zip にする）: `iruka-0.1.0-windows-x64.zip`、9.7 MB、展開後 27 MB。
  `C:\Users\tosihide\Foundry\dist` にもコピー。`dumpbin /dependents` でたどり、システム以外の DLL が
  すべて入っていることを確認。オーナーが別の場所に展開して動作を確認。

### 開発ビルドで 3840×2160 の RDP を 6 本開いて見たこと

- Iruka 全体で約 7 GB。あるリモートが 4K の画面全体を送り続けている間、ウィンドウ全体が約 10 秒
  固まった: 32 MB のフレーム 1 枚の `copy_ms` が 220〜380 ms（最適化なしの開発ビルド）、送信から
  WebView に届くまで約 1 秒（`lag_ms_max`）、固まっている間は最大 9.6 秒。5 秒のフレーム確認の
  タイムアウトが繰り返し発動。リリースビルドで再確認する。ここから出たメモリの疑問:
  [memory-reduction_JA.md](memory-reduction_JA.md)。
## 2026-10-26（夜）: 8 GB の Windows ノート

- 機械: Dell Inspiron 13-5378（i5-7200U、2 コア 4 スレッド、7.9 GiB）、Windows 11 Pro 24H2
  build 26100、WebView2 155、Smart App Control オフ。Ubuntu 側で使った ThinkPad とは別の機械。
  VS Community 2026 の C++ ツール、Rust 1.99.1、Node 26.12.1、クローンと `node_modules` は導入済み
  だった。vcpkg と `iruka-env.ps1` は新しく用意した。
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 44.9 分（OpenSSL だけで
  36 分、FreeRDP 6 分）。vcpkg で入るのは **FreeRDP 3.32.2** になった（以前は 3.32.1）。OpenSSL が
  遅いのは Kaspersky（`avp`）が新しいファイルを検査しているためかもしれない（未確認）。
- `tauri build --no-bundle`: 14.2 分（cargo は 13 分 58 秒）。`scripts/make-zip.ps1` で同じ 9.7 MB
  の zip（展開後 27.0 MB）を作り、`C:\Users\tosihide\Foundry\dist` に展開。そこから起動する
  （セッションなしで約 290〜370 MB）。
- Windows 10 は確認しないとオーナーが判断（サポート終了のため）。
- 計測前の待機状態: Chrome、Kaspersky、Dell SupportAssist が動いていて（Dropbox は終了）、空きは
  約 2.3〜2.6 GB。ページファイルはシステム管理（3.3 GB、コミット上限 11.4 GB）で、オーナーが
  設定した 24〜32 GB は効いていなかったため、再起動のためにここで中断。計測用スクリプト
  （`C:\Users\tosihide\Foundry\memlog.ps1`、リポジトリ外）が 5 秒ごとに Iruka と WebView2 の
  プロセス群、Chrome、空きメモリ、コミット、ページファイル使用量を `memlog.csv` に書く。
- 再起動後: ページファイル 24〜32 GB、コミット上限 32.6 GB。

### 7.9 GiB で 3840×2160 を 6 本、展開した zip のリリースビルド

オーナーが手でセッションを 1 本ずつ開いた（プロファイルがローカルの 4K の大きさでつなぐため、
予定の 1920×1080 ではなかった）。プライベートバイトは Iruka が実際に確保しているコミット、
ワーキングセットは Windows が RAM に置いておくことを許している分。

| 本数 | Chrome なし: iruka.exe プライベート / WebView2 プライベート / `used_mb` | Chrome あり（Prime Video 再生中）: 同じ / ページファイル使用量 |
| --- | --- | --- |
| 0 | 7 MB / 160 MB / 400 | 7 MB / 160 MB / 384。Chrome のワーキングセット 3.7 GB、空き 0.75 GB |
| 1 | 540 MB / 650 MB / 1,500〜1,600 | 540 MB / 600〜720 MB / 1,100。70 MB |
| 2 | 1.18 GB / 980 MB / 2,050〜2,110 | 1.05〜1.37 GB / 850〜1,010 MB / 1,940。540 MB |
| 3 | 1.56 GB / 1.02 GB / 2,650〜2,720 | 1.56〜1.86 GB / 1.0〜1.24 GB / 1,940。537 MB |
| 4 | 2.07 GB / 1.13 GB / 2,560〜2,650 | 2.07〜2.34 GB / 1.0〜1.33 GB / 1,730。528 MB |
| 5 | 2.6 GB / 1.27〜1.39 GB / 2,480〜2,540 | 2.58〜2.79 GB / 1.19〜1.53 GB / 1,720。910 MB |
| 6 | 3.1〜3.4 GB / 1.35〜1.55 GB / 2,400〜2,700 | 3.1〜3.4 GB / 1.15〜1.48 GB / 1,720。884 MB |

- どちらの場合も 6 本とも動き、何も落ちなかった。最初の 4K セッションは約 1.2 GB（32 GB 機と同じ）、
  2 本目以降は 1 本あたりプライベートバイトで約 0.5〜0.6 GB で、Linux の 525〜551 MB に近い。
  6 本で Iruka 全体の確保量は約 4.5〜4.9 GB。
- **限界はメモリではない。** Chrome なしでは 4 本目から Windows が Iruka のワーキングセットを削り
  （iruka.exe 1.35 → 0.5 GB）、圧縮ストアに回す（Memory Compression 335 → 610 MB）。ページファイルは
  40 MB のまま、コミットは 32.6 GB 中 11 GB。Chrome ありでは Chrome（ワーキングセット 3.7 → 1.3 GB）と
  Iruka の両方を削り、ページファイルは約 0.9 GB まで増え（ほとんどは 2 本目と 5 本目の接続時）、
  コミットは 14.3 GB。24〜32 GB のページファイルは必要よりはるかに大きい。
- **限界は 2 コアの CPU。** オーナー: 6 本で「カクカクして反応が鈍いけど、落ちない」。Chrome なしでは
  ウィンドウ全体の固まりが 2 回（6 本すべての 5 秒のフレーム確認タイムアウトが同じ秒に出た、20:00:04
  と 20:00:55）、`lag_ms_max` は平均 1.0 秒（最大 2.2 秒）。Chrome ありではタイムアウトが 44 回で、
  サムネイルの描画は続いたまま 4〜5 本で同時に 5 秒おきに繰り返し、`lag_ms_max` は平均 2.2 秒
  （最大 4.0 秒）。Chrome ありでも 5 本まではタイムアウトなし。5 秒おきの計測は 8〜12 秒に延びた。
  CPU 使用率そのものは記録していない。
- Chrome の Prime Video は 3 本と並べてもなめらかに再生し、5 本目の接続時に一瞬止まった（その時点で
  ページファイルが 380 MB 増えた）。Iruka が全画面の間も止まるが、これは Chrome が隠れたページを
  止めているためで、Iruka のせいではない。
- セッションを 6 本開いたままウィンドウを閉じる: 2 回ともきれいに終了（終了コード 0）、Iruka の
  WebView2 プロセスも数秒で消えた。Linux の閉じるときのクラッシュ（KNOWN_ISSUES_JA.md）はここでは
  起きない。
- Windows エラー報告が `RADAR_PRE_LEAK_64`（コミットが増え続けるプロセスについてのリーク検出の報告。
  クラッシュではない）を、20:04 に iruka.exe、20:08 に msedgewebview2.exe について記録した。
- Windows ではメモリモデルがワーキングセットから学ぶ（`sysinfo` の `memory()` は `WorkingSetSize`）
  ので、メモリが足りないと低く読む: Chrome なしの計測中に学習した係数が 1.83 から 1.65 に下がった。
  2 回目は 15 秒のウォームアップ中に最初のセッションを開いたので、何も学ばなかった（TODO_JA.md）。
- クラッシュも TDR もなし: Chrome ありの計測中、オーナーはグラフィックドライバーのエラーが
  Claude Code の上に出たかもしれないと思ったが、その時刻のシステムログに画面ドライバーのイベント
  （4101）はない。

### ポータブル zip は OpenSSL の legacy プロバイダーを一度も読み込めていなかった（修正済み）

- 2 回とも接続時に `OpenSSL LEGACY provider failed to load, no md4 support available!` と md4 / rc4
  の警告が出た。`legacy.dll` は `iruka.exe` の横にあり、Iruka は起動時に `OPENSSL_MODULES` を設定
  しているのに。Windows の接続先にはそれでもつながった（NTLM ではなかったらしい）。
- 起動前に変数を設定すると警告は消えたので、起動時のコードが原因: `std::env::set_var` はプロセスの
  環境変数しか変えないが、OpenSSL は C ランタイムのコピーを `getenv` で読む。`_wputenv_s`（両方を
  更新する）で修正。再ビルド 2 分 43 秒。変数なしで展開したフォルダーから、Windows と Ubuntu の
  両方の接続先で legacy / md4 / rc4 の行なし。KNOWN_ISSUES_JA.md「vcpkg の OpenSSL が legacy
  プロバイダーを見つけられない」。

## 2026-11-12: 新しいマシン（NucBox-M5-5）から 0.1.2 をリリース

- マシン: NucBox-M5-5、16 スレッド、32 GB、Windows 11 Pro ビルド 26300。clone は
  `C:\Users\tosihide\Foundry\Repo\Iruka`。既にあったもの: VS Build Tools 2026（18.4.2、C++）、
  Node 24.14.1、Git、`gh`（ログイン済み）。ユーザー単位で導入: rustup（winget）、vcpkg
  （`C:\Users\tosihide\Foundry\vcpkg`）、`C:\Users\tosihide\Foundry\iruka-env.ps1`。
- Smart App Control はまたオンだった。vcpkg のビルド前にオーナーがオフにした。
- `vcpkg install "freerdp[client]:x64-windows" "pkgconf:x64-windows"`: 9.3 分、FreeRDP 3.32.2。
- `tauri build --no-bundle`: ゼロから 5.4 分、警告なし。`scripts\make-zip.ps1` →
  `release\iruka-0.1.2-windows-x64.zip`（9.6 MB、展開後 26.8 MB）。
- 確認: vcpkg を `PATH` から外し `OPENSSL_MODULES` なしで、展開したコピーが起動する（ウィンドウが
  開く）。RDP / SSH の接続は試していない。
- GitHub release `v0.1.2`（Latest、pre-release ではない）として commit b7774aa で公開。
