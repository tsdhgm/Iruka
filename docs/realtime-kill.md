*日本語版: [realtime-kill_JA.md](realtime-kill_JA.md)*

# Why Iruka vanished under load, and why Remmina does not (2026-10-23)

A record of one investigation, kept because the mechanism is easy to forget and the questions it
raised about Iruka's design are worth keeping. The short entry is in KNOWN_ISSUES.md ("Linux: the
whole app is killed (SIGKILL) under heavy load"); this page has the full story and the Q&A.

Environment: Ubuntu 26.04, kernel 7.0.0-38-generic (HZ=1000), WebKitGTK 2.52.6, FreeRDP 3.32.1,
Iruka 0.1.0 from the deb, OBS Studio capturing the 3840×2160 display through PipeWire.

## 1. Symptom

With OBS running, Iruka disappeared repeatedly: six runs between 16:17 and 16:31 ended after 1.5
to 4 minutes (the last after 27 s), each with 4 to 5 sessions at 3840×2160 open and a memory peak
of about 3 GB. There was no dialog and no message. The owner's word for it was "abort".

## 2. Investigation

1. **Journal**: the systemd scope of each run simply ended (`app-gnome-Iruka-<pid>.scope: Consumed
   … 3.1G memory peak`). Nothing from Iruka, GTK, WebKit or FreeRDP before the end. No apport report,
   no `segfault` line from the kernel, no systemd-oomd kill, cgroup `oom_kill` counters at zero.
   Conclusion at that point: not a crash signal (those leave a trace), so either a silent `exit()`
   or a SIGKILL.
2. **Exit status**: launched from the dock, so unknown. A temporary launcher was installed: a copy of
   the deb's desktop entry in `~/.local/share/applications/` whose `Exec` ran `/usr/bin/iruka`
   under `gdb -batch`, logging to `~/.local/state/iruka/gdb.log`. Result after the next
   reproduction (2 min 49 s, three 4K sessions): `Program terminated with signal SIGKILL`.
3. **Who sends SIGKILL**: SIGKILL cannot be caught, so the sender had to come from the kernel's
   signal tracepoint. The owner ran, with sudo in a separate terminal:

   ```
   bpftrace -e 'tracepoint:signal:signal_generate /args->sig == 9/ {
     printf("%s to %s(%d) from %s(%d) code=%d\n", strftime("%H:%M:%S", nsecs),
            args->comm, args->pid, comm, pid, args->code); }'
   ```

   and the next reproduction printed:

   ```
   17:47:37 sig=9 to ReceiveQueue(pid 155573) from ReceiveQueue(pid 155355 tid 155573) code=128
   ```

   `code=128` is `SI_KERNEL`: the kernel itself generated the signal, in the context of the thread
   named `ReceiveQueue` of the Iruka process (pid 155355). No SIGXCPU (24) appeared before it.

## 3. The mechanism

- **Real-time scheduling and `RLIMIT_RTTIME`.** A thread under `SCHED_RR` or `SCHED_FIFO` preempts
  every normal thread, so a runaway one can freeze the machine. As a safeguard, a process may carry
  `RLIMIT_RTTIME`: the CPU time one of its real-time threads may use *without blocking*. At the soft
  limit the kernel sends SIGXCPU; at the hard limit it sends SIGKILL to the whole process, with no
  message unless `kernel.print-fatal-signals` is set. Normal threads are never subject to this.
- **RealtimeKit.** Unprivileged processes get real-time priority by asking the `rtkit-daemon`
  system service over D-Bus. It only agrees if the process has set `RLIMIT_RTTIME` to at most its
  maximum, 200 ms. So "real-time" always comes bundled with "killed after 200 ms".
- **WebKitGTK.** WTF's `RealTimeThreads` (in `libjavascriptcoregtk`) asks RealtimeKit to put the
  IPC receive threads of the UI process on `SCHED_RR` priority 5 and sets `RLIMIT_RTTIME` to hard
  200 ms / soft 160 ms. In Iruka these are the two threads named `ReceiveQueue` (from
  `com.apple.IPC.ReceiveQueue`); `ps -L -o tid,cls,rtprio,comm -p $(pgrep -x iruka)` shows them as
  `RR 5`, and `/proc/<pid>/limits` shows `Max realtime timeout 160000 200000 us`. Iruka did not ask
  for any of this. WebKit also installs a SIGXCPU handler that demotes its threads at the soft
  limit, through an eventfd watched by the GLib main loop; in the trace no SIGXCPU was generated
  at all, so the safety net did not help here (why the soft limit was skipped is not understood).
- **Why Iruka trips it.** The Tauri UI lives in WebKit's web process. Every frame of every RDP
  session goes from the Rust side through WebKit's IPC to the web process (a full 4K frame is
  33 MB), and input events and command replies come back the same way. With four or five 4K
  sessions the receive thread has data waiting almost continuously, and when OBS's 4K capture and
  encoder compete for the CPU, the thread goes more than 200 ms without ever blocking. The kernel
  then kills the process. It is a load threshold, not a bug in Iruka's code, and it will reappear
  under any comparable load even without OBS.

## 4. Q&A

**Is the cause that an Iruka thread exceeds a 200 ms per-thread limit set by the kernel?**
Not quite. The limit is not a general rule for threads; it applies only to real-time threads of a
process that carries `RLIMIT_RTTIME`. Iruka's own threads (FreeRDP receive, frame copies, the
Rust side) are ordinary `SCHED_OTHER` threads and may run for as long as they like. The only
real-time threads in the process are the two `ReceiveQueue` threads WebKitGTK created, and WebKit
also attached the limit.

**Why does Remmina not die?** Because it does not use WebKitGTK. Checked on the running Remmina
(pid 5009): zero real-time threads, `Max realtime timeout unlimited`, no WebKit in `ldd`. Remmina
draws the FreeRDP framebuffer straight into a GTK drawing area with cairo, in one process, with no
IPC in the frame path, so the condition for this kill never exists. Among the processes RealtimeKit
promoted that day, the regulars were pipewire, wireplumber and gnome-shell's input thread; the only
ordinary application was Iruka, on WebKit's behalf.

**Is WebKitGTK used because the outside is written in Rust, or for IronRDP?** Neither. It comes
with Tauri: a Rust core plus an HTML/JavaScript UI rendered by the platform web view (WebKitGTK on
Linux, WebView2 on Windows). Rust itself does not require a web view (gtk-rs, egui, iced, Slint
exist), and IronRDP is just an RDP library unrelated to the UI. Tauri was chosen because the same
UI code runs on Windows and Linux, and because xterm.js gives the SSH console for free.

**Remmina versus Iruka, design.**

| | Remmina | Iruka |
|---|---|---|
| Processes | one (C + GTK) | two or more (Rust core + WebKit web process) |
| Frame path | FreeRDP decodes → cairo paints the GTK drawing area | FreeRDP decodes → Rust copies → IPC to the web process → canvas → WebKit compositor |
| Copies per frame | about one | three or four (33 MB each at 4K) |
| Terminal | none (launches an external terminal) | xterm.js built in |
| Many PCs at once | no (one window per connection) | thumbnail grid |
| Portability | Linux-centred | same code on Windows |

The SIGKILL, and the higher memory use seen on Windows, are the price of the IPC in the frame
path; the Windows client working within days is the benefit of Tauri.

**Could thumbnails be done with GTK and cairo directly?** Yes. A thumbnail is the framebuffer
drawn scaled into a small drawing area, which is a cairo scale and paint; Remmina scales its
windows the same way. The terminal could be the VTE widget (GNOME Terminal's). The FreeRDP C bridge
and the Rust session management would largely carry over; what would be rewritten is the UI layer
(all of the HTML/TypeScript), and the Windows build would then depend on GTK's Windows port or a
second UI. Recorded as an option, not a plan.

## 5. Decision

Per the project rule, problems outside Iruka are recorded, not worked around (owner's decision,
2026-10-23). The candidate workaround, if the rule is ever relaxed, is in KNOWN_ISSUES.md and
TODO.md: demote the process's own `SCHED_RR` threads back to `SCHED_OTHER` from the memory
sampler thread, repeated because WebKit re-promotes them when a view becomes visible. The limit
itself cannot be raised: RealtimeKit caps it at 200 ms and a process can only lower its hard limit.
The temporary gdb launcher was removed; the bpftrace script stays at
`~/.local/state/iruka/who-kills-iruka.bt` on the Ubuntu box.
