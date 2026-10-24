*English version: [linux-diagnostics.md](linux-diagnostics.md)*

# Linux で Iruka が消えたとき: 原因の調べ方

Ubuntu（GNOME、Wayland）機向けの手順書。消えた Iruka の窓を二度追いかけた（高負荷時の SIGKILL は
docs/realtime-kill_JA.md、もう一度は作者が使っている最中に終わった回）あとにまとめた。背景の悪戦苦闘は
[linux-diagnostics-log_JA.md](linux-diagnostics-log_JA.md)。補助スクリプトは `scripts/diag/` にある。

## 1. 何がどこに痕跡を残すか

| 終わり方 | `iruka` の終了ステータス | ほかの痕跡 |
|---|---|---|
| 普通に閉じた | 0 | なし |
| 起動中にもう一つ起動した（Tauri の setup がパニック、KNOWN_ISSUES_JA.md） | 101 | 標準エラーに `thread 'main' panicked … a webview with label 'main' already exists` |
| Rust のパニック、FreeRDP の `abort()` | 101（パニック）または 134（SIGABRT） | パニックのメッセージが標準エラーに。SIGABRT ならコア / apport の報告 |
| セグフォルト | 139（SIGSEGV） | `journalctl -k` にカーネルの `segfault at …`。`coredumpctl list iruka` |
| メモリ不足 | 137（SIGKILL） | `journalctl -k` に `Out of memory: Killed process`、または systemd-oomd の行 |
| `RLIMIT_RTTIME` の番犬（docs/realtime-kill_JA.md） | 137（SIGKILL） | **何もない**。bpftrace の監視（4 節）だけが `code=128`、送り主は被害者自身の `ReceiveQueue` スレッド、と記録する |
| ログアウト、手で kill | 143（SIGTERM）または 137 | bpftrace の監視に `code=0` と送り主（gnome-session、systemd、bash） |

128 を超えるステータスは 128 + シグナル番号。下のラッパーはシグナル名も出す。

## 2. ジャーナルに最初からあるもの（インストール不要）

ドックから起動した Iruka は systemd のユーザースコープで動き、標準エラーは desktop エントリ名を識別子として
ユーザージャーナルに入る。

```sh
# Iruka 自身のログ（tracing、FreeRDP の WLog）。読みやすくするためフレームログを除く
journalctl --user -t Iruka.desktop -o short-iso --since "1 hour ago" | grep -v iruka_perf
# 「Iruka (no realtime)」から起動した分
journalctl --user -t iruka-no-realtime.desktop -o short-iso --since "1 hour ago"
# 各回の開始と終了、ピークメモリ（終了ステータスはない。スコープはそれを追跡しない）
journalctl --user -o short-iso --since today | grep -E "app-gnome-Iruka-[0-9]+\.scope"
```

落とし穴: `--since` は `"YYYY-MM-DD HH:MM"` か `today`、`"1 hour ago"` のような語。GNOME のスコープは
**ユーザー**ジャーナル（`--user`）にあり、システムジャーナルで `journalctl -u 'app-gnome-*'` とすると
"No data available" になる。FreeRDP の WLog は標準出力に出て、端末でないときはブロック単位でバッファされる
ので、ジャーナルには遅れてまとめて現れる。Iruka の `tracing` の行（標準エラー）は即時。デバッグログ
（`iruka_perf`、`iruka_mem`）は既定で有効（docs/code-notes_JA.md）なので `--debug` のようなオプションは
不要。絞るなら `IRUKA_LOG`。

## 3. 終了ステータスを記録する: `iruka-logged`

```sh
scripts/diag/install-launchers.sh          # --remove で元に戻す
```

`~/.local/bin/iruka-logged` を入れる。`/usr/bin/iruka` を起動し、1 回ごとに 1 行を
`~/.local/state/iruka/exit.log` とジャーナル（`journalctl --user -t iruka-exit`）に追記する。

```
start=2026-10-24 10:27:07 end=2026-10-24 10:27:11 mode=normal killed by signal 9 (SIGKILL)
start=2026-10-24 10:36:51 end=2026-10-24 10:38:28 mode=normal exit code 101
```

あわせて、deb の desktop エントリのユーザー側上書き（`~/.local/share/applications/Iruka.desktop`。名前、
アイコン、`StartupWMClass` は同じで `Exec` だけラッパーに向ける）、`iruka-no-realtime` 起動口（D-Bus の
システムバスを隠す、docs/realtime-kill_JA.md）、ドックの二つ目のエントリ「Iruka (no realtime)」も入れる。
後者も同じラッパーを通る（`mode=no-realtime`）。

## 4. シグナルの送り主を記録する: bpftrace の監視

SIGKILL は捕まえられず、送り主の痕跡も残らない。見えるのはカーネルのシグナル用トレースポイントだけ。
`scripts/diag/who-kills-iruka.bt` はマシン上のすべての致命シグナル（SIGKILL、SIGTERM、SIGXCPU、SIGSEGV、
SIGABRT、SIGBUS）を、被害者、送り主、`si_code` とともに出す。`scripts/diag/iruka-kill-watch.service` は
それを system サービス（root）として動かし、出力をシステムジャーナルに送る。

```sh
sudo scripts/diag/install-kill-watch.sh                  # --remove で元に戻す
journalctl -u iruka-kill-watch -o short-iso -f           # adm グループなら読むのに sudo は不要
journalctl -u iruka-kill-watch -o short-iso | grep -E 'iruka|ReceiveQueue'
```

行の読み方: `code=0` はユーザー空間からの `kill()` で、"from" が送り主。`code=128` は `SI_KERNEL`、
カーネル自身が生成したもので、"from" はたまたま走っていたタスクにすぎない。`RLIMIT_RTTIME` の番犬の場合
それは被害者自身の `ReceiveQueue` スレッドになる。ログアウト時には SIGTERM の行がまとまって出るが正常。
一回だけ端末で見るなら `sudo bpftrace -B line scripts/diag/who-kills-iruka.bt`（`-B line` がないと
終了まで出力がバッファされる）。

## 5. ほかの確認

```sh
journalctl -k --since today | grep -iE "oom|killed process|segfault"   # カーネル: OOM、セグフォルト
journalctl --user -u systemd-oomd --since today; journalctl -u systemd-oomd --since today
coredumpctl list iruka; ls /var/crash                                  # コア、apport
ps -L -o tid,cls,rtprio,comm -p "$(pgrep -x iruka)" | grep -E 'RR|FF'  # リアルタイムスレッド
grep realtime "/proc/$(pgrep -x iruka)/limits"                        # RLIMIT_RTTIME
journalctl -u rtkit-daemon --since today | grep "$(pgrep -x iruka)"    # RealtimeKit の昇格
```

## 6. すべて外す

```sh
scripts/diag/install-launchers.sh --remove
sudo scripts/diag/install-kill-watch.sh --remove
rm -rf ~/.local/state/iruka
```
