*English: [realtime-kill.md](realtime-kill.md)*

# 高負荷時に Iruka が消えた理由と、Remmina が消えない理由（2026-10-23）

一つの調査の記録。仕組みは忘れやすく、調査の途中で出た Iruka の設計についての問いも残す価値があるので、ページにした。短い要約は KNOWN_ISSUES_JA.md（「Linux: 高負荷時…アプリ全体が SIGKILL で消える」）にあり、ここには経緯と質疑応答の全部を書く。

環境: Ubuntu 26.04、カーネル 7.0.0-38-generic（HZ=1000）、WebKitGTK 2.52.6、FreeRDP 3.32.1、deb からインストールした Iruka 0.1.0、OBS Studio が PipeWire で 3840×2160 のディスプレイをキャプチャ中。

## 1. 症状

OBS を動かしていると Iruka が何度も消えた。16:17 から 16:31 の間に 6 回、それぞれ起動後 1.5〜4 分（最後は 27 秒）で、毎回 3840×2160 のセッションを 4〜5 本開いた状態、メモリのピークは約 3 GB。ダイアログもメッセージも出ない。作者の言葉では「アボート」。

## 2. 調査

1. **ジャーナル**: 各回とも systemd のスコープが終わっただけ（`app-gnome-Iruka-<pid>.scope: Consumed … 3.1G memory peak`）。終了前に Iruka、GTK、WebKit、FreeRDP のどれも何も出していない。apport の報告なし、カーネルの `segfault` 行なし、systemd-oomd の kill なし、cgroup の `oom_kill` カウンタもゼロ。この時点の結論: クラッシュのシグナルなら痕跡が残るので、黙った `exit()` か SIGKILL のどちらか。
2. **終了コード**: ドックから起動していたので不明。一時的な起動口を入れた。deb の desktop エントリを `~/.local/share/applications/` に複製し、`Exec` を `/usr/bin/iruka` を `gdb -batch` の下で動かして `~/.local/state/iruka/gdb.log` に記録するスクリプトに差し替えた。次の再現（2 分 49 秒、4K セッション 3 本）の結果: `Program terminated with signal SIGKILL`。
3. **SIGKILL の送り主**: SIGKILL は捕まえられないので、送り主はカーネルのシグナルのトレースポイントから取るしかない。作者が別ターミナルで sudo で次を実行した。

   ```
   bpftrace -e 'tracepoint:signal:signal_generate /args->sig == 9/ {
     printf("%s to %s(%d) from %s(%d) code=%d\n", strftime("%H:%M:%S", nsecs),
            args->comm, args->pid, comm, pid, args->code); }'
   ```

   次の再現で出た行:

   ```
   17:47:37 sig=9 to ReceiveQueue(pid 155573) from ReceiveQueue(pid 155355 tid 155573) code=128
   ```

   `code=128` は `SI_KERNEL`。カーネル自身が、Iruka プロセス（pid 155355）の `ReceiveQueue` というスレッドの文脈でシグナルを生成した。その前に SIGXCPU（24）は出ていない。

## 3. 仕組み

- **リアルタイムスケジューリングと `RLIMIT_RTTIME`。** `SCHED_RR` や `SCHED_FIFO` のスレッドはすべての普通のスレッドを押しのけるので、暴走すると機械が固まる。その保険として、プロセスに `RLIMIT_RTTIME` を持たせられる。リアルタイムスレッドが*ブロックせずに*使ってよい CPU 時間で、ソフト上限で SIGXCPU、ハード上限でプロセス全体に SIGKILL が送られる。`kernel.print-fatal-signals` を立てていなければメッセージは出ない。普通のスレッドはこの対象にならない。
- **RealtimeKit。** 権限のないプロセスは、D-Bus で `rtkit-daemon` に頼んでリアルタイム優先度をもらう。rtkit はプロセスが `RLIMIT_RTTIME` を自分の上限（200 ms）以下に設定している場合しか応じない。つまり「リアルタイム」には必ず「200 ms で kill」が付いてくる。
- **WebKitGTK。** WTF の `RealTimeThreads`（`libjavascriptcoregtk` 内）が RealtimeKit に頼んで UI プロセスの IPC 受信スレッドを `SCHED_RR` 優先度 5 にし、`RLIMIT_RTTIME` をハード 200 ms / ソフト 160 ms に設定する。Iruka ではこれが `ReceiveQueue`（`com.apple.IPC.ReceiveQueue` から）という名前の 2 本で、`ps -L -o tid,cls,rtprio,comm -p $(pgrep -x iruka)` で `RR 5` と見え、`/proc/<pid>/limits` に `Max realtime timeout 160000 200000 us` と出る。Iruka はどれも頼んでいない。WebKit はソフト上限で SIGXCPU を受けてスレッドを降格させるハンドラーも入れている（eventfd を GLib のメインループで見張る）が、トレースでは SIGXCPU 自体が生成されておらず、この保険は効かなかった（ソフト上限が飛ばされた理由は未解明）。
- **Iruka がこれに当たる理由。** Tauri の UI は WebKit の Web プロセスにいる。RDP セッションのフレームはすべて Rust 側から WebKit の IPC を通って Web プロセスへ渡り（4K の全画面フレームは 33 MB）、入力イベントやコマンドの応答は同じ経路で戻る。4K を 4〜5 本開くと受信スレッドにはほぼ常にデータが待っていて、そこに OBS の 4K キャプチャとエンコーダーが CPU を取り合うと、スレッドが一度もブロックせずに 200 ms を超える。そこでカーネルがプロセスを kill する。Iruka のコードのバグではなく負荷の閾値で、OBS がなくても同程度の負荷なら再び起きる。

## 4. 質疑応答

**原因は、カーネルが決めた 1 スレッドあたり 200 ms の上限を Iruka のスレッドが超えること？**
少し違う。この上限はスレッド一般の規則ではなく、`RLIMIT_RTTIME` を持つプロセスのリアルタイムスレッドにだけ効く。Iruka 自身のスレッド（FreeRDP の受信、フレームのコピー、Rust 側）は普通の `SCHED_OTHER` で、いくら走っても構わない。プロセス内のリアルタイムスレッドは WebKitGTK が作った `ReceiveQueue` 2 本だけで、上限を付けたのも WebKit。

**Remmina はなぜ落ちない？** WebKitGTK を使っていないから。動いていた Remmina（pid 5009）で確認: リアルタイムスレッド 0 本、`Max realtime timeout unlimited`、`ldd` に WebKit なし。Remmina は FreeRDP のフレームバッファーを 1 プロセス内で cairo を使って GTK の描画領域に直接描き、フレーム経路に IPC がないので、この kill の条件がそもそも成立しない。その日 RealtimeKit が昇格させた相手は、常連が pipewire、wireplumber、gnome-shell の入力スレッドで、普通のアプリは WebKit の代理で頼んだ Iruka だけだった。

**WebKitGTK を使っているのは、外側を Rust で書いたから？ IronRDP のため？** どちらでもない。Tauri に付いてくるもの。Tauri は Rust の本体と HTML/JavaScript の UI で、UI はプラットフォームの Web ビュー（Linux は WebKitGTK、Windows は WebView2）が描く。Rust 自体は Web ビューを要求しない（gtk-rs、egui、iced、Slint がある）し、IronRDP はただの RDP ライブラリで UI とは無関係。Tauri を選んだのは、同じ UI コードが Windows と Linux で動くことと、xterm.js で SSH コンソールがそのまま手に入ることから。

**Remmina と Iruka の設計の比較。**

| | Remmina | Iruka |
|---|---|---|
| プロセス | 1 つ（C + GTK） | 2 つ以上（Rust 本体 + WebKit の Web プロセス） |
| フレームの経路 | FreeRDP が展開 → cairo が GTK の描画領域に描く | FreeRDP が展開 → Rust がコピー → IPC で Web プロセスへ → canvas → WebKit の合成 |
| フレームあたりのコピー | ほぼ 1 回 | 3〜4 回（4K では 1 回 33 MB） |
| 端末 | なし（外部端末を起動） | xterm.js を内蔵 |
| 多数の PC を同時に | 不可（1 接続 1 ウィンドウ） | サムネイルの格子 |
| 移植性 | Linux 中心 | Windows でも同じコード |

SIGKILL と、Windows で目立ったメモリの多さはフレーム経路に IPC を挟む代償で、Windows クライアントが数日で動いたのは Tauri の利点。

**GTK と cairo で直接描いてもサムネイルは作れる？** 作れる。サムネイルはフレームバッファーを縮小して小さな描画領域に描くだけで、cairo の拡縮と描画で済む。Remmina もウィンドウの拡縮を同じ方法でやっている。端末は VTE 部品（GNOME 端末のもの）で置き換えられる。FreeRDP の C ブリッジと Rust のセッション管理はおおむね流用でき、書き直すのは UI 層（HTML/TypeScript 全部）。Windows 版は GTK の Windows 移植に頼るか、別の UI を持つことになる。計画ではなく選択肢として記録する。

**GTK は Linux 専用で、GTK 版の Iruka は Windows で別の実装が要る？** GTK は Linux 専用ではなく、Windows と macOS でも動く（GIMP や Inkscape の Windows 版が GTK）。ただし Windows 対応は二級。見た目が Windows らしくならない（テーマ、フォント描画、HiDPI の癖）、GTK のランタイム（数十の DLL）を同梱して MSYS2 環境でビルドする必要がある、Wayland や RealtimeKit のような Linux の仕組みは存在せず Windows 固有の調整が別に要る。したがって GTK + cairo の Iruka は、GTK の Windows 移植に乗るか、Windows だけ別の UI（たとえば WebView2）を持つかを選ぶことになる。Tauri は UI を OS の Web ビューに任せることでこの分岐を避けていた。参考に、FreeRDP 本体のクライアントは X11 用（xfreerdp）、Wayland 用、Windows 用（wfreerdp）が別々に書かれ、唯一の共通実装は SDL 版（sdl-freerdp）。GTK より薄い描画層である SDL も移植性の選択肢になる。

**Remmina が Linux だけなのは GTK を直接使うから？** 違う。GTK は Windows でも動く。Remmina が Linux だけなのは設計と目的による。Linux のデスクトップ基盤に深く依存し（パスワード保存は libsecret、ホスト発見は Avahi、libssh、SPICE と VNC のプラグイン、X11/Wayland のキーボードとクリップボードの扱い）、目的が「Linux デスクトップ*から*つなぐクライアント」で、Windows には mstsc が最初からある。FreeBSD 版はあり、Windows でのビルドを試みた例もあるが、公式版はない。「GTK を直接使う = Linux 専用」ではなく「GTK を直接使うと Windows 対応に手間がかかる」が正確で、Remmina にはその手間をかける理由がなかった。

**GTK は Linux と Windows/macOS で実装レベルに差がある？ リアルタイム性能が要る機能は Windows で別の実現方法が要る？** GTK の API は全 OS で同じだが、その下の層（GDK のバックエンド。Linux は X11 と Wayland、Windows は Win32、macOS は Quartz）が OS ごとに別実装で、差はそこにある。描画（Linux では Wayland と GPU 合成に乗れるが、Windows の GTK3 は cairo のソフトウェア描画を GDI で転送し GPU 加速はほぼ効かない）、入力（IME、キーボード配列、マウスのキャプチャ、ドラッグ&ドロップ）、高 DPI、テーマ、ファイルダイアログ、配布。「リアルタイム」は 2 つの意味に分かれる。

1. *スケジューリングの意味のリアルタイム*（このページの主題）は GTK の機能ではない。WebKitGTK が Linux の RealtimeKit で自分のスレッドの優先度を上げた結果。GTK 自体はリアルタイムスレッドを使わず、Windows には RealtimeKit も `RLIMIT_RTTIME` もなく、WebView2 もそういうことをしないので、Windows にはこの問題が存在せず、置き換えるものもない。RDP クライアントにリアルタイム優先度は要らない。
2. *スループット*（4K フレームを滞りなく描くこと）は本当に必要で、OS ごとに事情が違う。4K を 30 fps で描くと 1 秒あたり約 1 GB のピクセルを動かすので、コピーして画面に出す経路が効く。Linux の GTK + cairo は CPU でこなせる（Remmina が証拠）。Windows の GTK も同じ方法で動くが、GDI 転送の分だけ余裕が減る。Windows で本気で出すなら、FreeRDP の wfreerdp のように GDI や Direct3D を直接使うか、SDL のように両 OS で GPU のテクスチャとしてフレームを出す層を挟む。sdl-freerdp が Linux と Windows で同じコードなのはそのため。

まとめると「GTK の実装レベルに差がある」は正しく、主に描画の経路と配布で出る。このページの原因だった「リアルタイム」は Linux 固有で Windows には持ち込まれない。Windows で別途設計が要るのはスレッドの優先度ではなく、フレームを画面に出す経路。

**WebKitGTK が RealtimeKit に `RLIMIT_RTTIME` をお願いすることが発生条件の一つ。もしその設定をしなければ、Iruka が遅くなることはあっても kill はされない？** ほぼそのとおりで、2 段階に分けると正確になる。

1. WebKitGTK は自分のプロセスに `RLIMIT_RTTIME`（ハード 200 ms、ソフト 160 ms）を `setrlimit` で自分で設定する。RealtimeKit にお願いするものではなく、RealtimeKit が応じるための前提条件として自分で付ける。
2. そのうえで RealtimeKit に `ReceiveQueue` スレッド 2 本を `SCHED_RR` 優先度 5 にしてもらう。1 がなければ RealtimeKit は断る。

カーネルが kill するのは「スレッドがリアルタイム」かつ「`RLIMIT_RTTIME` が有限」の両方が成り立つときだけ。上限は普通のスレッドには何もしないので、どちらか一方が欠ければ kill は起きない。

- 1 がなければ RealtimeKit が 2 を断り、スレッドは普通のまま。上限も kill もない。
- 1 なしで 2 だけ（特権が要るので通常は不可能）なら kill は避けられるが、上限が守っていた危険、つまり暴走したリアルタイムスレッドが機械を固める危険が戻る。
- 1 を残したままスレッドを `SCHED_OTHER` に戻しても kill は終わる。TODO_JA.md の回避策の候補（スレッドの降格）が効くのはこのため。

Iruka の遅延は目に見えて変わらない。リアルタイム化の狙いは、ブラウザーが音声や動画を再生するときに IPC の反応をミリ秒単位で安定させること。受信スレッドが普通の優先度なら他の普通のスレッドと公平に CPU を分け合うだけで、フレームが数ミリ秒遅れうる程度。Remmina のフレーム経路には優先度の仕掛けが何もなく、それで問題ない。つまり `RLIMIT_RTTIME` の設定は発生条件の一つで、それがなければ RealtimeKit が断る結果としてリアルタイムスレッドが存在せず、カーネルが kill するものもない。

**メモリ計測モジュールに降格の処理を入れずに、起動オプションで最初から `SCHED_OTHER` のままにできる？** できる。しかも Iruka を一切変えずに済む。WebKitGTK は RealtimeKit に D-Bus の*システムバス*経由で頼むので、プロセスの起動時にシステムバスの場所を存在しないパスに向けておくと依頼が届かず、スレッドは普通のまま、`RLIMIT_RTTIME` も設定されない（WebKit はこの設定を RealtimeKit への依頼の途中でしか行わない）。2026-10-23 に `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent` を付けて `/usr/bin/iruka` を起動して確認した。

| | 通常起動 | 環境変数あり |
|---|---|---|
| `SCHED_RR` のスレッド | `ReceiveQueue` 2 本 | なし |
| `Max realtime timeout` | 160 ms / 200 ms | unlimited |
| rtkit-daemon のログ | 昇格 2 件 | なし |
| 標準エラーの警告 | | なし |

ドックからこの方法で起動するには、deb の desktop エントリをユーザー側で上書きする（戻すときはこのファイルを消す）。

```sh
sed 's|^Exec=iruka$|Exec=env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent iruka|' \
  /usr/share/applications/Iruka.desktop > ~/.local/share/applications/Iruka.desktop
```

注意点: Iruka がほかにシステムバスを使う場面は見当たらない（音声は PipeWire のソケット、RDP はただの TCP、GTK の設定はセッションバス）が、確認したのは起動だけで、RDP セッションと音声を開いた状態は試していないので、普段の使い方で確かめること。Iruka 自身にこのための起動オプションはない（`--no-realtime` を付けるなら、GTK の初期化前に同じ環境変数を設定する数行）。除外した代替案: WebKit に無効化の環境変数はない。polkit で RealtimeKit を拒否するとユーザー全体（PipeWire も）に効く。systemd の `RestrictRealtime` は rtkit 経由の昇格を止められない（rtkit-daemon が自分のプロセスからスレッドのポリシーを変えるため）。

実使用での結果（2026-10-23）: この方法で起動した Iruka は、OBS が 4K 画面をキャプチャしている横で kill されずに動いた（通常起動では数分で kill されていた）。OBS が動いている間は Iruka の反応が目に見えて遅くなった。遅さの原因が OBS 自身のキャプチャとエンコードの負荷なのか、IPC スレッドが普通の優先度になったことなのかは切り分けていない。音声とクリップボードは試していない。作者はこの起動を OBS の録画のときだけ使う。上書きの代わりにドックのエントリをもう一つ作る方法もある: 環境変数を設定して `/usr/bin/iruka` を exec するスクリプト `~/.local/bin/iruka-no-realtime` と、`Name=Iruka (no realtime)`、`Icon=iruka` で `StartupWMClass` を*付けない* `~/.local/share/applications/iruka-no-realtime.desktop`。付けないのは、起動中の窓（app id `iruka`）を常に deb の「Iruka」エントリに紐づけ、新しいエントリを純粋な起動ボタンにしておくため。

**D-Bus とは何か。** Linux のデスクトップでプロセス同士が通信するためのメッセージバス。プログラムは決まった名前の下に*オブジェクト*と*インターフェース*と*メソッド*を公開し、ほかのプログラムはそのメソッドを呼んだりシグナルを受け取ったりする。相手ごとに独自のソケットプロトコルを作らずに済む。バスは 2 本ある。*システムバス*は 1 台に 1 本、起動時に立ち上がり、NetworkManager、UPower、udisks、RealtimeKit といったシステムサービスのためのもので、誰が何を呼べるかはポリシーファイルと polkit が決める。*セッションバス*はログインセッションごとに 1 本で、通知、ポータル、設定、クリップボード管理といったデスクトップの用事に使う。プロセスは環境変数 `DBUS_SESSION_BUS_ADDRESS` と `DBUS_SYSTEM_BUS_ADDRESS` でバスの場所を知る（後者の既定は `/run/dbus/system_bus_socket`）。だからこの変数を存在しないパスに向けると、そのプロセスとその子からだけバスが見えなくなる。この話では、WebKit がシステムバス上の名前 `org.freedesktop.RealtimeKit1` のオブジェクト `/org/freedesktop/RealtimeKit1` に対してメソッド `MakeThreadRealtimeWithPID` を呼んでいる。

**RealtimeKit とは何か。** 普通のユーザーのプロセスのスレッドに、頼まれればリアルタイムスケジューリングを与える小さなシステムサービス（`rtkit-daemon`。root で動き `CAP_SYS_NICE` を持つ）。これがないと、root か `RLIMIT_RTPRIO` を 0 より大きくしてもらったユーザーしか `SCHED_RR` や `SCHED_FIFO` を使えない。音声のために存在する。PulseAudio、いまは PipeWire と WirePlumber が、機械が忙しくても音が途切れないように音声スレッドの昇格を頼む。暴走したリアルタイムスレッドは機械全体を固められるので、rtkit は条件付きでしか応じない。polkit が呼び出し元を許すこと（ローカルで操作中のユーザーなら許される）、呼び出し元のプロセスが `RLIMIT_RTTIME` を rtkit の上限 200 ms 以下にあらかじめ設定していること（リアルタイムスレッドがそれだけブロックせずに走ったらカーネルがプロセスを kill するように）、優先度に上限があること、ユーザーあたりのリアルタイムスレッド数とプロセス数に上限があること、そしてカナリアスレッドがシステムを見張り、カナリアが時間内にスケジュールされなくなったら rtkit が昇格させたスレッドを全部降格させること。WebKitGTK は IPC 受信スレッドのために同じサービスを使っていて、リアルタイムなど何も頼んでいない Iruka が 200 ms の上限と kill を背負うことになったのはそのため。

**「バス」と聞くとハードウェアのバスを思い浮かべる。D-Bus の「システムバス」は Linux 固有の言葉？** ハードウェアではなく、ここでの「バス」はソフトウェアの比喩。ハードウェアのバスが「1 本の共有線に多数の部品がぶら下がり、宛先を付けてやり取りする」ものであるのと同じ構図をプロセス間通信に当てはめたもので、*メッセージバス*と呼ばれる種類の仕組み。実体は `/run/dbus/system_bus_socket` のような Unix ソケットで待ち受けるデーモン（`dbus-daemon` または `dbus-broker`）で、各電文を宛先の名前を持つプロセスへ振り分ける。

「システムバス」「セッションバス」は freedesktop.org が公開している D-Bus 仕様の公式な用語で、仕様はメッセージバスの標準インスタンスとして「システム全体に 1 つ」と「ログインセッションごとに 1 つ」の 2 つを定めている。ツールも同じ言葉を使う（`dbus-send --system` / `--session`、`busctl --system` / `--user`）。Linux 一般の用語ではなく D-Bus の用語で、D-Bus はカーネルの機能ではなくユーザー空間のサービス（カーネルに取り込む kdbus という試みはあったが採用されなかった）。Linux と BSD のデスクトップ（GNOME、KDE、systemd の周辺）で標準的に使われる。Windows と macOS にも移植版があり GTK アプリがそこで使うことはあるが、それらの OS 自身は同じ役割に別の仕組みを持つ。Windows は COM と RPC、macOS は XPC と Mach ポート、Android は Binder。したがって「D-Bus のシステムバス」は「Linux デスクトップの、システムサービス向けのプロセス間通信の窓口」と読める。

## 5. 決定

プロジェクトの決めごとどおり、Iruka の外側の問題は記録するだけでコードでは回避しない（作者の判断、2026-10-23）。決めごとを緩める日が来たときの回避策の候補は KNOWN_ISSUES_JA.md と TODO_JA.md にある: メモリ計測スレッドから自プロセスの `SCHED_RR` スレッドを `SCHED_OTHER` に戻す（WebKit はビューが見えるようになると再昇格させるので繰り返す）。上限そのものは上げられない。RealtimeKit が 200 ms で頭打ちにし、プロセスはハード上限を下げることしかできない。一時的な gdb の起動口は削除済み。bpftrace スクリプトは Ubuntu 機の `~/.local/state/iruka/who-kills-iruka.bt` に残している。
