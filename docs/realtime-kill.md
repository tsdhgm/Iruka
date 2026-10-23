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

**Is GTK Linux-only, so a GTK-based Iruka would need a different implementation on Windows?**
GTK is not Linux-only: it runs on Windows and macOS (GIMP and Inkscape ship Windows builds on it).
But Windows support is second-class. The look does not become Windows-like (theme, font rendering,
HiDPI quirks); the GTK runtime (dozens of DLLs) must be shipped with the app and built in an MSYS2
environment; and Linux mechanisms such as Wayland or RealtimeKit do not exist there, so Windows
needs its own adjustments instead. A GTK + cairo Iruka would therefore choose between riding GTK's
Windows port and keeping a separate UI for Windows (WebView2, say). Tauri avoided that fork by
handing the UI to the platform web view. For comparison, FreeRDP's own clients are written
separately for X11 (xfreerdp), Wayland and Windows (wfreerdp); the only shared one is the SDL
client (sdl-freerdp), and SDL, a thinner drawing layer than GTK, is another portability option.

**Is Remmina Linux-only because it uses GTK directly?** No; GTK would run on Windows. Remmina is
Linux-only by design and purpose: it leans on the Linux desktop stack (libsecret for passwords,
Avahi for discovery, libssh, SPICE and VNC plugins, X11/Wayland keyboard and clipboard handling),
and its goal is a client *from* a Linux desktop, where Windows already has mstsc. A FreeBSD port
exists; attempts at Windows builds have been made, but there is no official one. So "uses GTK
directly" does not mean "Linux-only"; it means "Windows costs extra effort", and Remmina had no
reason to pay it.

**Does GTK differ between Linux and Windows/macOS at the implementation level, and would
"real-time" features need a different approach on Windows?** The GTK API is the same everywhere;
the layer below it (the GDK backend: X11 and Wayland on Linux, Win32 on Windows, Quartz on macOS)
is a separate implementation per OS, and that is where the differences live: drawing (on Linux GTK
rides Wayland and GPU compositing; GTK3 on Windows draws with cairo in software and blits through
GDI, with almost no GPU acceleration), input (IME, keyboard layouts, mouse capture, drag and
drop), HiDPI, theming and file dialogs, and distribution. "Real-time" splits into two meanings:

1. *Scheduling real-time*, the subject of this page, is not a GTK feature at all. It was WebKitGTK
   using Linux's RealtimeKit to raise its own threads' priority. GTK itself uses no real-time
   threads, Windows has neither RealtimeKit nor `RLIMIT_RTTIME`, and WebView2 does nothing of the
   kind, so the problem does not exist on Windows and nothing needs replacing there. An RDP client
   does not need real-time priority.
2. *Throughput*, drawing 4K frames without stalling, is genuinely needed and does differ per OS.
   4K at 30 fps moves about 1 GB of pixels per second, so the copy-and-present path matters. GTK +
   cairo on Linux handles it on the CPU (Remmina is the proof); GTK on Windows works the same way
   with less headroom because of the GDI blit. Serious Windows output uses GDI or Direct3D directly,
   as FreeRDP's wfreerdp does, or a layer such as SDL that presents frames as GPU textures on both
   systems, which is why sdl-freerdp is one code base for Linux and Windows.

So "GTK differs at the implementation level" is true, mostly in the drawing path and distribution.
The real-time issue behind this page is Linux-specific and would not travel to Windows; what
Windows would need designed separately is the frame presentation path, not thread priorities.

**WebKitGTK asking RealtimeKit for `RLIMIT_RTTIME` is one of the conditions, then. Without that
setting, would Iruka only get slower, never killed?** Nearly right, with the two steps separated:

1. WebKitGTK sets `RLIMIT_RTTIME` (hard 200 ms, soft 160 ms) on its own process itself, with
   `setrlimit`. It is not something it asks RealtimeKit for; it is the precondition RealtimeKit
   demands before it will help.
2. Only then does it ask RealtimeKit to put the two `ReceiveQueue` threads on `SCHED_RR` priority 5.
   Without step 1, RealtimeKit refuses.

The kernel kills only when both hold: the thread is real-time *and* `RLIMIT_RTTIME` is finite. The
limit does nothing to ordinary threads, so removing either half removes the kill:

- Without step 1, RealtimeKit refuses step 2, the threads stay ordinary, and there is neither a
  limit nor a kill.
- Step 2 without step 1 (only possible with privileges) would avoid the kill but bring back the
  danger the limit exists for: a runaway real-time thread freezing the machine.
- Leaving step 1 in place but putting the threads back to `SCHED_OTHER` also ends the kill, which
  is why the candidate workaround in TODO.md (demote the threads) would work.

Iruka's latency would not change in any noticeable way. The real-time promotion exists so that a
browser playing audio or video keeps its IPC response steady to within milliseconds. With the
receive thread at normal priority it shares the CPU fairly with the other ordinary threads, and a
frame may arrive a few milliseconds later; Remmina's frame path has no priority trick at all and is
fine. So yes: the `RLIMIT_RTTIME` setting is one of the conditions, and without it, because
RealtimeKit would then refuse, there is no real-time thread and nothing for the kernel to kill.

**Could a launch option keep the threads at `SCHED_OTHER` from the start, without the demotion
code in the memory sampler?** Yes, and without changing Iruka at all: WebKitGTK reaches RealtimeKit
over the D-Bus *system bus*, so if the process is started with the system bus pointed at a path
that does not exist, the request never arrives, the threads stay ordinary, and `RLIMIT_RTTIME` is
never set (WebKit only sets it in the middle of the RealtimeKit request). Verified on 2026-10-23 by
starting `/usr/bin/iruka` with `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent`:

| | normal start | with the variable |
|---|---|---|
| `SCHED_RR` threads | two `ReceiveQueue` | none |
| `Max realtime timeout` | 160 ms / 200 ms | unlimited |
| rtkit-daemon log | two promotions | none |
| warnings on stderr | | none |

To start that way from the dock, override the deb's desktop entry for the user (delete the file
to go back):

```sh
sed 's|^Exec=iruka$|Exec=env DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent iruka|' \
  /usr/share/applications/Iruka.desktop > ~/.local/share/applications/Iruka.desktop
```

Caveats: nothing else in Iruka is known to use the system bus (audio goes through PipeWire's
socket, RDP is plain TCP, GTK settings use the session bus), but the check covered only start-up,
not an open RDP session with audio, so it should be tried in normal use. Iruka has no option of its
own for this (`--no-realtime` would be a few lines setting the same variable before GTK starts).
Rejected alternatives: WebKit has no environment switch for it; a polkit rule denying RealtimeKit
would hit the whole user (PipeWire included); systemd's `RestrictRealtime` does not stop promotion
through rtkit, because rtkit-daemon changes the thread's policy from its own process.

**What is D-Bus?** The message bus Linux desktops use for communication between processes. A
program offers *objects* with *interfaces* and *methods* under a well-known name, and other
programs call those methods or listen for signals, instead of each pair inventing its own socket
protocol. There are two buses. The *system bus* is one per machine, started at boot, for system
services such as NetworkManager, UPower, udisks and RealtimeKit; who may call what is controlled by
policy files and polkit. The *session bus* is one per login session, for desktop matters:
notifications, the portals, settings, the clipboard manager. A process finds a bus through the
environment variables `DBUS_SESSION_BUS_ADDRESS` and `DBUS_SYSTEM_BUS_ADDRESS` (the latter defaults
to `/run/dbus/system_bus_socket`), which is why pointing the variable at a non-existent path hides
the bus from that one process and its children. In this story, WebKit calls the method
`MakeThreadRealtimeWithPID` on the object `/org/freedesktop/RealtimeKit1` of the name
`org.freedesktop.RealtimeKit1` on the system bus.

**What is RealtimeKit?** A small system service (`rtkit-daemon`, running as root with the
`CAP_SYS_NICE` capability) that hands real-time scheduling to threads of ordinary user processes
on request. Without it only root, or users given `RLIMIT_RTPRIO` above zero, could use `SCHED_RR`
or `SCHED_FIFO` at all. It exists because audio needs it: PulseAudio, and now PipeWire and
WirePlumber, ask it for their audio threads so that sound does not stutter when the machine is
busy. Because a runaway real-time thread can freeze the whole machine, rtkit only agrees under
conditions: polkit must allow the caller (an active local user does); the calling process must
already have set `RLIMIT_RTTIME` to at most rtkit's maximum of 200 ms, so that the kernel will
kill the process if a real-time thread runs that long without blocking; the priority is capped;
the number of real-time threads and processes per user is limited; and a canary thread watches
the system, demoting every thread rtkit promoted if the canary stops being scheduled in time.
WebKitGTK uses the same service for its IPC receive threads, which is how Iruka, which never asked
for real-time anything, ended up with the 200 ms limit and the kill.

**"Bus" brings a hardware bus to mind. Is D-Bus's "system bus" a Linux-specific term?** It is not
hardware; "bus" here is a software metaphor. A hardware bus is one shared line with many parts
attached, exchanging addressed messages, and D-Bus applies the same picture to processes: it is
a *message bus*. The thing itself is a daemon (`dbus-daemon` or `dbus-broker`) listening on a Unix
socket such as `/run/dbus/system_bus_socket`, which routes each message to the process that owns
the destination name.

"System bus" and "session bus" are official terms of the D-Bus specification published by
freedesktop.org, which defines two standard instances of the message bus: one for the whole
system and one per login session. The tools use the same words (`dbus-send --system` /
`--session`, `busctl --system` / `--user`). They are D-Bus terms rather than general Linux terms:
D-Bus is a user-space service, not a kernel feature (an attempt to move it into the kernel,
kdbus, was not merged), and it is standard in Linux and BSD desktops (GNOME, KDE, the systemd
ecosystem). Ports exist for Windows and macOS and GTK applications may use them there, but those
operating systems have their own mechanisms for the same job: COM and RPC on Windows, XPC and
Mach ports on macOS, Binder on Android. So "the D-Bus system bus" reads as "the Linux desktop's
inter-process channel for system services".

## 5. Decision

Per the project rule, problems outside Iruka are recorded, not worked around (owner's decision,
2026-10-23). The candidate workaround, if the rule is ever relaxed, is in KNOWN_ISSUES.md and
TODO.md: demote the process's own `SCHED_RR` threads back to `SCHED_OTHER` from the memory
sampler thread, repeated because WebKit re-promotes them when a view becomes visible. The limit
itself cannot be raised: RealtimeKit caps it at 200 ms and a process can only lower its hard limit.
The temporary gdb launcher was removed; the bpftrace script stays at
`~/.local/state/iruka/who-kills-iruka.bt` on the Ubuntu box.
