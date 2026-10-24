*English version: [linux-diagnostics-log.md](linux-diagnostics-log.md)*

# Linux 診断の作業記録（試行錯誤）

Ubuntu 機で Iruka の窓が消えた原因を突き止めるまでの時系列の記録。行き止まりも含む。整理した手順は
[linux-diagnostics_JA.md](linux-diagnostics_JA.md)、高負荷時の SIGKILL の仕組みと質疑応答は
[realtime-kill_JA.md](realtime-kill_JA.md)。

## 2026-10-23: OBS で画面キャプチャ中に Iruka が消える

### 環境

- Ubuntu 26.04、カーネル 7.0.0-38-generic、GNOME（Wayland）、WebKitGTK 2.52.6、FreeRDP 3.32.1。
- deb の Iruka 0.1.0 をドックから起動（端末なし、終了ステータスなし）。
- OBS Studio が PipeWire 経由で 3840×2160 の画面をキャプチャ。RDP セッションは 3840×2160 を 4〜5 本。

### 第 1 段階: ジャーナル

- 作者の報告は「アボートする」。端末に何もないので、まずジャーナルへ。
- `journalctl --since '2026-10-23 16:16:00'` が "No entries" を返した。その時間帯に行があるのは確かなのに
  理由は結局わからなかった。回避: 広い範囲を `-o short-iso` で出して ISO の時刻を awk で絞る。
  （後日、秒なしの `--since "2026-10-23 16:16"` や `--since today` は動いたので、秒が問題だったのかもしれない。）
- メモリサンプルの awk 集計が `min=1024 max=509` になった。awk がフィールドを文字列として比較していた。
  `u+0` で数値にする。
- ジャーナルにあったもの: 各回の `Started app-gnome-Iruka-<pid>.scope` と、最後の
  `app-gnome-Iruka-<pid>.scope: Consumed … 3.1G memory peak`。終了直前に Iruka、GTK、WebKit、FreeRDP の
  いずれからも何もない。apport の報告なし（`/var/crash` は空）、カーネルの `segfault` 行なし、systemd-oomd
  の kill なし、cgroup の `memory.events` は `oom_kill 0`。
- 結論: クラッシュのシグナルなら痕跡が残るので、黙った `exit()` か SIGKILL のどちらか。16:17〜16:31 の
  6 回は 1.5〜4 分、最後は 27 秒で終わっていた。

### 第 2 段階: ドック起動の終了ステータスを得る

- ドック起動には端末がない。手口: deb の desktop エントリをユーザー側 `~/.local/share/applications/Iruka.desktop`
  に複製するとファイル名でシステム側を上書きできる。その `Exec` からスクリプト `~/.local/bin/iruka-gdb` を呼び、
  `gdb -batch -ex run -ex 'info threads' …` で `/usr/bin/iruka` を動かして `~/.local/state/iruka/gdb.log` に記録。
- 作者から「ドック起動は本当に gdb を通っている？（アイコンが同じに見える）」。通っていた。同じファイル名、
  同じアイコンで、上書きはドックからは見えない。
- 次の再現は 4K セッション 3 本で 2 分 49 秒後: `Program terminated with signal SIGKILL, Killed. The program
  no longer exists.` gdb は送り主を言えない。`info threads` が走る前にスレッドは消えていた。
- `/proc/sys/kernel/print_fatal_signals` は存在しない。正しくは `print-fatal-signals`（ハイフン）で値は 0。
  どのみち役に立たなかった: カーネルが出力するのはコアダンプを伴うシグナルだけで、SIGKILL は含まれない
  （SIGXCPU は含まれるが WebKit が捕まえる）。

### 第 3 段階: SIGKILL の送り主

- 送り主が見えるのはカーネルの `signal:signal_generate` トレースポイントだけ。Claude Code は `sudo` を使えない
  ので作者が自分の端末で bpftrace を実行。構文確認の `bpftrace --dry-run` でさえ root が要る
  （`/sys/kernel/tracing` を開くため）。
- 最初は `args->sig == 9` だけの一行。残した版（`~/.local/state/iruka/who-kills-iruka.bt`、いまは
  `scripts/diag/who-kills-iruka.bt`）は SIGTERM、SIGXCPU、SIGSEGV、SIGABRT、SIGBUS と `si_code` も出す。
- 出力が「遅れて表示」された: 端末でないとき bpftrace は標準出力をブロック単位でバッファする（作者はパイプに
  通していた）。`-B line` で直る。サービスの unit はそれを使う。
- 結果: `17:47:37 sig=9 to ReceiveQueue(pid 155573) from ReceiveQueue(pid 155355 tid 155573) code=128`。
  `code=128` は `SI_KERNEL`、「送り主」は被害者自身のスレッド。プロセスではなくカーネルの番犬。直前に
  SIGXCPU はなし。
- 動いている Iruka で確認: `ps -L -o tid,cls,rtprio,comm` に `RR` 優先度 5 の `ReceiveQueue` が 2 本。
  `/proc/<pid>/limits` に `Max realtime timeout 160000 200000`。rtkit-daemon がそれらについて
  "Successfully made thread … RT at priority 5" を記録していた。WebKit の
  `Source/WTF/wtf/glib/RealTimeThreads.cpp` を読んで、誰が設定し、切るスイッチがないことを確認。
  比較の Remmina（pid 5009）: RT スレッドなし、上限 unlimited。
- `pgrep -E` というオプションはない（無害な間違い）。
- 作者の判断: 記録のみ（Iruka の外側の問題についてのプロジェクトの決めごと）。gdb の起動口と desktop の
  上書きは削除、bpftrace スクリプトは残した。

### 夕方: コードを変えない回避策とドックの二つ目のエントリ

- `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent` でシステムバスを隠すと WebKit は RealtimeKit に届かず、
  RT スレッドも上限もない（起動時に確認）。スクリプト `~/.local/bin/iruka-no-realtime` と、`StartupWMClass`
  なしの desktop エントリ「Iruka (no realtime)」として残した。なしにするのは起動中の窓を通常のエントリに
  紐づけたままにするため。
- OBS との実使用で確認: kill されないが、OBS が動いている間は Iruka の反応が目に見えて遅い。原因は未切り分け
  （OBS の負荷と、普通の優先度になった IPC スレッド）。

## 2026-10-24: 「使っている最中に死んだかもしれない」

### 動機

- 作者が Iruka を本格的に使い始めた。05:05 以降 6 回起動（ユーザージャーナルのスコープ行）。最長は 08:00〜10:16
  でピーク 1.8 GB。どの回にも終了ステータスがなく、あとから閉じたのか kill されたのか判別できない。カーネル
  ログに OOM の行はなし。
- 三つの希望: 端末から起動せずに終了ステータスを見たい、`--debug` スイッチ、bpftrace の一行を「何とかログに」。

### わかったこと

- **`--debug` は不要**: ドックから起動した Iruka の標準エラーはすでにユーザージャーナルに入っていて、識別子は
  desktop エントリ名（`-t Iruka.desktop`）。デバッグフィルターは既定で有効。前日からで 377,546 行、大半は
  `iruka_perf`。
- システムジャーナルでの `journalctl -u 'app-gnome-*'` は "No data available" で失敗する。GNOME のアプリの
  スコープはユーザージャーナル（`--user`）にある。
- スコープの `Consumed` 行は開始、終了、CPU 時間、ピークメモリを出すが**終了ステータスはない**。スコープには
  主プロセスという概念がない。
- FreeRDP の WLog（標準出力）がジャーナルに 80 秒遅れてひとまとまりで届いた。行の中の時刻は書かれた時点を
  示している。端末がないと標準出力はブロック単位でバッファされる。標準エラーの `tracing` の行は即時。

### ラッパーと、事故が見つけたバグ

- `~/.local/bin/iruka-logged` は `/usr/bin/iruka` を起動し、ステータスを解読して（128 超はシグナル、名前は
  `kill -l N`）、`~/.local/state/iruka/exit.log` と、`systemd-cat -t iruka-exit` 経由でジャーナルに 1 行追記する。
  deb の desktop エントリはこれを使うよう上書き。`iruka-no-realtime` もこれを exec するので、どちらの
  エントリも `mode` 付きで記録される。
- 新しいインスタンスへの `kill -9` と `kill -TERM` のテストで `killed by signal 9 (SIGKILL)` と
  `killed by signal 15 (SIGTERM)` が出た。
- bpftrace の監視は system サービスにした（`iruka-kill-watch.service`、`bpftrace -q -B line`、出力は
  システムジャーナル、adm グループが読める）。`sudo` 用のインストールスクリプト付き。
- **事故**: その間に作者はドックから Iruka を起動していて（10:36:51）、RDP セッション 2 本で使っていた。
  10:38:28 に新しい起動口をテスト起動したところ、*作者の*インスタンスが終了コード 101 で終わり、テストの
  インスタンスは即座に 0 で終わった。理由はジャーナルにあった:
  `thread 'main' panicked at tauri-2.11.5/src/app.rs:1425: Failed to setup app: a webview with label 'main'
  already exists`。`enableGTKAppId: true` のため、二つ目のプロセスは GApplication のリモートインスタンスに
  なる。`activate` を動いている方に転送して 0 で終了し、動いている方はイベントループから二度目の `Ready` を
  受けて Tauri が `setup` をもう一度実行し、`main` 窓はすでにあるのでパニック。つまり **Iruka を二重に起動
  すると動いている Iruka が死ぬ**（KNOWN_ISSUES_JA.md。修正候補は TODO_JA.md）。ここでのテストの教訓:
  作者の Iruka が動いている間はテストのインスタンスを起動しない。まず `pgrep -x iruka`。
