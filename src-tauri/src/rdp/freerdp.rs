//! FreeRDP 3 バックエンド（native/freerdp_bridge.c 経由）。
//!
//! RDPGFX（Progressive / RemoteFX / H.264）に対応しているので、
//! Windows に加えて GNOME Remote Desktop の画面共有にもつながる。

use std::{
    ffi::{c_char, c_int, CStr, CString},
    sync::mpsc::{Receiver, TryRecvError},
};

use anyhow::{bail, Context as _};

use super::{Command, FrameSink, FrameView, RdpBackend, RdpConnectParams, RdpInput, Rect, MAX_DIRTY_RECTS};

/// イベント待ちの最大時間。この間隔で入力キューと画面の送信も確認する。
const POLL_TIMEOUT_MS: u32 = 15;

#[repr(C)]
struct RdpContext {
    _private: [u8; 0],
}

extern "C" {
    fn iruka_rdp_new(argc: c_int, argv: *const *const c_char) -> *mut RdpContext;
    fn iruka_rdp_connect(ctx: *mut RdpContext) -> c_int;
    fn iruka_rdp_poll(ctx: *mut RdpContext, timeout_ms: u32) -> c_int;
    fn iruka_rdp_framebuffer(ctx: *mut RdpContext, width: *mut u32, height: *mut u32, stride: *mut u32) -> *const u8;
    fn iruka_rdp_take_dirty(ctx: *mut RdpContext, out: *mut u32, max: c_int) -> c_int;
    fn iruka_rdp_send_mouse(ctx: *mut RdpContext, flags: u16, x: u16, y: u16);
    fn iruka_rdp_send_extended_mouse(ctx: *mut RdpContext, flags: u16, x: u16, y: u16);
    fn iruka_rdp_send_key(ctx: *mut RdpContext, scancode: u16, down: c_int);
    fn iruka_rdp_last_error(ctx: *mut RdpContext) -> *const c_char;
    fn iruka_rdp_disconnect(ctx: *mut RdpContext);
    fn iruka_rdp_free(ctx: *mut RdpContext);
}

// freerdp/input.h
const PTR_FLAGS_HWHEEL: u16 = 0x0400;
const PTR_FLAGS_WHEEL: u16 = 0x0200;
const PTR_FLAGS_MOVE: u16 = 0x0800;
const PTR_FLAGS_DOWN: u16 = 0x8000;
const PTR_FLAGS_BUTTON1: u16 = 0x1000; // 左
const PTR_FLAGS_BUTTON2: u16 = 0x2000; // 右
const PTR_FLAGS_BUTTON3: u16 = 0x4000; // 中
const PTR_XFLAGS_DOWN: u16 = 0x8000;
const PTR_XFLAGS_BUTTON1: u16 = 0x0001;
const PTR_XFLAGS_BUTTON2: u16 = 0x0002;

pub struct FreeRdp;

impl RdpBackend for FreeRdp {
    fn name(&self) -> &'static str {
        "FreeRDP"
    }

    fn run(
        &self,
        params: &RdpConnectParams,
        commands: &Receiver<Command>,
        sink: &mut FrameSink,
    ) -> anyhow::Result<String> {
        let session = Session::new(params)?;
        session.connect()?;
        session.run(commands, sink)
    }
}

/// FreeRDP のセッション 1 本。作ったスレッドからだけ使う。
struct Session {
    ctx: *mut RdpContext,
    connected: std::cell::Cell<bool>,
    /// 最後に押されたマウス位置（ボタンやホイールのイベントにも座標が要る）
    mouse: std::cell::Cell<(u16, u16)>,
}

impl Session {
    fn new(params: &RdpConnectParams) -> anyhow::Result<Self> {
        let (domain, username) = params.domain_and_user();
        // FreeRDP のコマンドライン形式で設定する（xfreerdp と同じ既定値になる）
        let mut args = vec![
            "iruka".to_owned(),
            format!("/v:{}", params.host),
            format!("/port:{}", params.port()),
            format!("/u:{username}"),
            format!("/p:{}", params.password),
            format!("/size:{}x{}", params.width, params.height),
            "/bpp:32".to_owned(),
            // グラフィックスパイプライン（GNOME Remote Desktop に必須）と回線の自動判定
            "/gfx".to_owned(),
            "/network:auto".to_owned(),
            // 自己署名証明書を受け入れる（mstsc の「続行」相当）
            "/cert:ignore".to_owned(),
            "-clipboard".to_owned(),
        ];
        // 音声の入出力。再生・録音の方式は FreeRDP が OS に合わせて選ぶ（Linux なら PulseAudio）
        if params.audio {
            args.push("/sound".to_owned());
        } else {
            args.push("/audio-mode:2".to_owned()); // 音声は再生しない
        }
        if params.microphone {
            args.push("/microphone".to_owned());
        }
        if let Some(domain) = domain {
            args.push(format!("/d:{domain}"));
        }
        let cargs: Vec<CString> = args
            .into_iter()
            .map(CString::new)
            .collect::<Result<_, _>>()
            .context("接続設定に使えない文字が含まれています")?;
        let argv: Vec<*const c_char> = cargs.iter().map(|a| a.as_ptr()).collect();

        let ctx = unsafe { iruka_rdp_new(argv.len() as c_int, argv.as_ptr()) };
        if ctx.is_null() {
            bail!("FreeRDP のセッションを作れませんでした（設定の解析に失敗）");
        }
        Ok(Self {
            ctx,
            connected: false.into(),
            mouse: (0, 0).into(),
        })
    }

    fn last_error(&self) -> String {
        let msg = unsafe { iruka_rdp_last_error(self.ctx) };
        if msg.is_null() {
            return "不明なエラー".into();
        }
        unsafe { CStr::from_ptr(msg) }.to_string_lossy().into_owned()
    }

    fn connect(&self) -> anyhow::Result<()> {
        // 失敗しても後片付け（切断処理）は必要なので先に立てる
        self.connected.set(true);
        if unsafe { iruka_rdp_connect(self.ctx) } == 0 {
            bail!("接続に失敗しました: {}", self.last_error());
        }
        Ok(())
    }

    fn framebuffer(&self) -> Option<FrameView<'_>> {
        let (mut width, mut height, mut stride) = (0, 0, 0);
        let data = unsafe { iruka_rdp_framebuffer(self.ctx, &mut width, &mut height, &mut stride) };
        if data.is_null() {
            return None;
        }
        // SAFETY: gdi の primary_buffer は stride * height バイト。次の poll までは変わらない
        let data = unsafe { std::slice::from_raw_parts(data, stride as usize * height as usize) };
        Some(FrameView {
            data,
            width,
            height,
            stride: stride as usize,
        })
    }

    fn run(&self, commands: &Receiver<Command>, sink: &mut FrameSink) -> anyhow::Result<String> {
        let mut size = (0, 0);
        loop {
            loop {
                match commands.try_recv() {
                    Ok(Command::Input(inputs)) => inputs.into_iter().for_each(|i| self.send_input(i)),
                    Ok(Command::Close) | Err(TryRecvError::Disconnected) => return Ok("切断しました".into()),
                    Err(TryRecvError::Empty) => break,
                }
            }

            let status = unsafe { iruka_rdp_poll(self.ctx, POLL_TIMEOUT_MS) };

            if let Some(fb) = self.framebuffer() {
                if (fb.width, fb.height) != size {
                    size = (fb.width, fb.height);
                    sink.resize(fb.width, fb.height)?;
                    // 作り直した画面は全体を送る
                    sink.damage(Rect {
                        x: 0,
                        y: 0,
                        width: fb.width,
                        height: fb.height,
                    });
                }
                let mut rects = [0u32; MAX_DIRTY_RECTS * 4];
                let n = unsafe { iruka_rdp_take_dirty(self.ctx, rects.as_mut_ptr(), MAX_DIRTY_RECTS as c_int) };
                for r in rects.chunks_exact(4).take(n.max(0) as usize) {
                    sink.damage(Rect {
                        x: r[0],
                        y: r[1],
                        width: r[2],
                        height: r[3],
                    });
                }
                sink.flush(&fb, status != 1)?;
            }

            match status {
                1 => {}
                0 => return Ok("サーバーが接続を閉じました".into()),
                _ => bail!("通信エラー: {}", self.last_error()),
            }
        }
    }

    fn send_input(&self, input: RdpInput) {
        let ctx = self.ctx;
        let (mx, my) = self.mouse.get();
        unsafe {
            match input {
                RdpInput::MouseMove { x, y } => {
                    self.mouse.set((x, y));
                    iruka_rdp_send_mouse(ctx, PTR_FLAGS_MOVE, x, y);
                }
                RdpInput::MouseButton { button, down } => {
                    let flags = match button {
                        0 => PTR_FLAGS_BUTTON1,
                        1 => PTR_FLAGS_BUTTON3,
                        2 => PTR_FLAGS_BUTTON2,
                        3 | 4 => {
                            let x = if button == 3 { PTR_XFLAGS_BUTTON1 } else { PTR_XFLAGS_BUTTON2 };
                            let down = if down { PTR_XFLAGS_DOWN } else { 0 };
                            iruka_rdp_send_extended_mouse(ctx, x | down, mx, my);
                            return;
                        }
                        _ => return,
                    };
                    let down = if down { PTR_FLAGS_DOWN } else { 0 };
                    iruka_rdp_send_mouse(ctx, flags | down, mx, my);
                }
                RdpInput::Wheel { vertical, units } => {
                    // 回転量は 9 ビットの 2 の補数（0x100 が負の符号）
                    let rotation = (units.clamp(-255, 255) as u16) & 0x01ff;
                    let kind = if vertical { PTR_FLAGS_WHEEL } else { PTR_FLAGS_HWHEEL };
                    iruka_rdp_send_mouse(ctx, kind | rotation, mx, my);
                }
                RdpInput::Key { scancode, down } => {
                    if down {
                        tracing::debug!(target: "iruka_perf", scancode, "key sent to FreeRDP");
                    }
                    iruka_rdp_send_key(ctx, scancode, down.into())
                }
                // FreeRDP は押下状態を管理しないので、フォーカスが外れたら修飾キーだけ離す
                RdpInput::ReleaseAll => {
                    for sc in [0x2a, 0x36, 0x1d, 0xe01d, 0x38, 0xe038, 0xe05b, 0xe05c] {
                        iruka_rdp_send_key(ctx, sc, 0);
                    }
                }
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            if self.connected.get() {
                iruka_rdp_disconnect(self.ctx);
            }
            iruka_rdp_free(self.ctx);
        }
    }
}
