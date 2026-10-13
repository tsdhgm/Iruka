*日本語版: [mac-target_JA.md](mac-target_JA.md)*

# Using a Mac as a target (research 2026-10-09, results 2026-10-13)

Findings on how to view a Mac's screen from Iruka running on Ubuntu / Windows, and what to try next.
Using a Mac as the monitoring machine (running Iruka on a Mac) is a separate topic and is not covered here.

## Results (2026-10-13)

**With clintcan/macrdp installed on the Mac, Iruka connected through the FreeRDP backend without any code changes.** For now this is how a Mac is used as a target; no VNC backend is being written.

- Before trying Iruka, it was confirmed that Remmina (RDP) could connect to the same macrdp.
- Confirmed working: screen display and interaction, key input, Japanese (kanji) input on the Mac, clipboard in both directions (local → remote, remote → local).
- Connected at 3840×2160. No codec or gfx errors in the FreeRDP log (it connects with macrdp's default bitmap transport).
- Memory: about 890 MB for Iruka as a whole with one session (about 410–530 MB right after start-up). Comparable to a Windows 4K session.
- Parked: **Option+V does not paste** (the Ctrl+V-equivalent key does reach the remote; it looks like a modifier mapping on the Mac side or a macrdp translation issue). It does not get in the way in practice, so it has not been investigated. Recorded in KNOWN_ISSUES.md.
- Not yet checked: audio, microphone, the resolution difference with and without Retina (`--hidpi`), full screen, the right-Alt grid toggle.

## Conclusions at research time (2026-10-09)

There are two realistic options. RustDesk is not suitable for embedding in Iruka.

| Approach | Work in Iruka | Mac side | Fit |
|---|---|---|---|
| 1. Connect to macOS's built-in Screen Sharing (VNC) | Add a VNC backend (medium) | Just switch it on in Settings | No extra software. The better long-term option |
| 2. Install an RDP server on the Mac (macrdp, or Remotr) | None (FreeRDP as is) | macrdp is open source (MIT / Apache-2.0); Remotr is paid (free tier available) | Can be tried right away. macrdp first |

## 1. macOS built-in Screen Sharing (VNC)

On the Mac, turn on "Settings → Sharing → Screen Sharing". There are two authentication modes, and the choice affects how much has to be implemented.

| Authentication | Mac-side setting | Rust library support |
|---|---|---|
| Standard VNC authentication (password only, security type 2) | In the Screen Sharing settings ("Computer Settings"), enable "VNC viewers may control screen with password" and set a password | `vnc-rs` supports it as is |
| Apple's own authentication (security type 30, user name and password, Diffie-Hellman + AES) | Default | Not supported by `vnc-rs`; would have to be added by hand |

### Libraries and reference implementations

- **`vnc-rs`** (crates.io): a VNC client in Rust. MIT / Apache-2.0. 0.6.0 (2026-09-21). Async on tokio. Supports Tight / ZRLE / Raw / CopyRect (Hextile / RRE not implemented, TRLE untested). The author tested it against "the built-in VNC server of macOS 12.6 (password login enabled)".
- **`rv`** (github.com/madeye/rv): a VNC viewer in Rust. MIT. Uses `vnc-rs` 0.5.3 and implements the ARD login (type 30) of Mac Screen Sharing itself. Being MIT as well, its authentication code could be ported into Iruka.
- **libvncclient** (LibVNC/libvncserver): C. `HandleARDAuth` implements type 30. GPL-2, so it is for reading only, not linking.

### Fitting it into Iruka (design notes)

- Implement `run` of the `RdpBackend` trait (`src-tauri/src/rdp/mod.rs`) and it plugs in. Draw into a private buffer and hand it to the `FrameSink` through `damage` / `flush`. Session management, thumbnails, the grid, full screen and the clipboard machinery are shared.
- **Key input is the one design difference**: RDP sends key positions (scancodes), VNC sends characters (X11 keysyms). Send `KeyboardEvent.key` along with the keydown from the frontend, and convert to keysyms on the VNC side.
- Connect form: add "VNC" to the backend choices. Default port 5900. Authentication is password only (plus a user name for Apple's own authentication). Audio / microphone / low memory do not apply (RDP only).
- When adding it, rename the trait and parameter types from `RdpBackend` / `RdpConnectParams` to something generic.
- Limitations: no audio. The basic clipboard is Latin-1; Japanese depends on the Extended Clipboard extension (macOS support unverified). VNC decodes the screen on the CPU, so Retina resolutions could be heavy.

## 2. Installing an RDP server on the Mac

### macrdp (clintcan/macrdp) — try first

- github.com/clintcan/macrdp. A native RDP server for macOS written in Rust on top of IronRDP. **MIT or Apache-2.0**. Started 2026-05; latest v0.9.11 (2026-10-02).
- **The default screen transport is bitmaps**; H.264 (hardware encoded) is optional (`--enable-h264`). Ubuntu's FreeRDP is built without H.264, so it should connect with the defaults.
- Authentication is NLA / CredSSP with the Mac account (user name and password). The README explicitly says it is verified with mstsc, Microsoft Remote Desktop and **FreeRDP**.
- Supports: clipboard (text, images, rich text, files), audio, microphone (experimental), Retina (`--hidpi`), a virtual display (headless), keyboard layout auto-detection, Cmd-key shortcut emulation.
- Limitations: one session / one user only, no multi-monitor. Positioned as v0, "practical for a single user over LAN or VPN".
- Default port is **3390** (not 3389).
- Installation: `cargo build --release` on the Mac, or the Apple Silicon binary from GitHub Releases (ad-hoc signed, not notarised, so right-click → Open on first launch). On first launch, grant the "Screen Recording" and "Accessibility" permissions and enter the Mac password.
- Caution: **there is an unrelated project with the same name, x6nux/macrdp (GPL-3.0).** That one documents H.264 only (AVC420 / AVC444) and may show no screen with Ubuntu's FreeRDP. Do not confuse the two.

### Remotr — if macrdp does not work out

- **Remotr**: a native RDP server for macOS released in March 2026. According to the developer, it is implemented from the MS-RDPBCGR specification and supports bitmaps and H.264, the clipboard, and authentication with macOS accounts. One-time purchase of 10–20 USD, with a feature-limited free tier. macOS 13 or later.
- No change in Iruka; connect through the FreeRDP backend.
- Caution: it is brand new and no third-party reviews or verification could be found. The only sources are the developer's posts and listing sites. Compatibility with FreeRDP (RDPGFX and H.264 handling; Ubuntu's FreeRDP is built without H.264) has to be verified in practice.

## Ruled out

- **RustDesk**: AGPL-3.0. Embedding it would make all of Iruka AGPL, and MIT could not be kept. No SDK and no published protocol specification. It can run as a separate application, but then it does not appear in Iruka's thumbnails or grid.
- **libvncclient** (GPL-2), **gtk-vnc / gvnc** (LGPL, awkward on Windows), **Sunshine + Moonlight** (GPL, designed for game streaming — a different purpose).

## What to try next

A was completed on 2026-10-13 (see "Results" above). B and C are for coming back to if macrdp runs into trouble.

### A. Connect to macrdp from Iruka as it is (no code changes) — done

1. Install clintcan/macrdp on the Mac (Releases binary or `cargo build --release`). Launch it, grant the Screen Recording and Accessibility permissions, and enter the Mac password. To accept connections from the LAN, use `--bind 0.0.0.0:3390`.
2. In Iruka's "+ RDP", enter `the Mac's IP address:3390` as the host (do not forget the port), the Mac account's user name and password, and Backend "Auto (FreeRDP first)".
3. Check: whether the screen appears, the resolution (Retina; differs with and without `--hidpi`), keyboard and mouse, clipboard, audio (turn on "Audio" in the connect form), full screen, memory usage (the `iruka_mem` log).
4. If it does not connect, look at the FreeRDP log in the `npm run tauri dev` terminal (`[ERROR]`, `codec`, `gfx`) and at macrdp's log. Iruka passes `/gfx`, so RDPGFX handling could be a compatibility point.
5. If macrdp is not enough, try Remotr's free tier (same steps; port 3389).

### B. VNC reconnaissance (no code changes)

1. Turn on Screen Sharing on the Mac and set a password under "VNC viewers may control screen with password".
2. Confirm with Remmina (VNC) on Ubuntu that a password-only connection works. This shows the Mac-side setup is correct.
3. If possible, also check whether Remmina connects with Apple's own authentication (user name and password).

### C. Implementing a VNC backend (depending on A and B)

1. Add `vnc-rs` as a dependency and write `vnc.rs` implementing `RdpBackend` (standard VNC authentication first; Raw / ZRLE / Tight).
2. Send `KeyboardEvent.key` from the frontend keydown and build a keysym conversion table.
3. Add "VNC" to the connect form.
4. Once it works, add Apple's own authentication (type 30) using `rv` as a reference.

## Sources

- [vnc-rs (docs.rs)](https://docs.rs/crate/vnc-rs/latest)
- [madeye/rv — Native desktop VNC viewer in Rust](https://github.com/madeye/rv)
- [Tenable: Detecting macOS High Sierra root account (explains authentication type 30 = ARD)](https://www.tenable.com/blog/detecting-macos-high-sierra-root-account-without-authentication)
- [KDE Bug 286138: Support for ARD authentication](https://bugs.kde.org/show_bug.cgi?id=286138)
- [clintcan/macrdp — A native RDP server for macOS, written in Rust on top of IronRDP](https://github.com/clintcan/macrdp)
- [x6nux/macrdp (unrelated project with the same name, GPL-3.0)](https://github.com/x6nux/macrdp)
- [Remotr — Native macOS RDP Server (AlternativeTo)](https://alternativeto.net/software/remotr--native-macos-rdp-server/about/)
- [Show GN: native macOS remote server for RDP (developer's post, Korean)](https://news.hada.io/topic?id=27916)
- [Product Hunt: profile of Remotr's author](https://www.producthunt.com/@kimbongchul)
- [Gentoo: net-misc/rustdesk (AGPL-3)](https://gpo.zugaina.org/net-misc/rustdesk)
- [Wikipedia: LibVNCServer (GPLv2)](https://en.wikipedia.org/wiki/LibVNCServer)
