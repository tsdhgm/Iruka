//! RDP セッションの共通部分。
//!
//! フロントとのやりとり（Tauri コマンドとイベント）、セッションの管理、
//! 画面の差分をまとめてフロントへ送る処理はここに集め、接続そのものは
//! バックエンド（FreeRDP / IronRDP）に任せる。バックエンドは
//! [`RdpBackend`] トレイトを実装すれば差し替えられる。

#[cfg(feature = "freerdp")]
mod freerdp;
#[cfg(feature = "ironrdp")]
mod ironrdp;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::NEXT_SESSION_ID;

/// フロントへ画面を送る最小間隔（約 30fps）。
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// ためておく変化範囲の上限。超えたら全体を 1 つの矩形にまとめる。
pub const MAX_DIRTY_RECTS: usize = 128;

/// バックエンドから画面側へのイベント（画面の中身は別の Channel でバイナリで送る）。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RdpEvent {
    /// 接続完了、またはサーバー側で画面サイズが変わった。
    #[serde(rename_all = "camelCase")]
    Resize { width: u32, height: u32 },
    #[serde(rename_all = "camelCase")]
    Closed {
        reason: String,
        error: bool,
        backend: &'static str,
    },
}

/// 画面側からの入力。座標はリモート画面のピクセル。
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RdpInput {
    MouseMove { x: u16, y: u16 },
    /// button は MouseEvent.button の値（0=左, 1=中, 2=右, 3/4=戻る/進む）
    MouseButton { button: u8, down: bool },
    /// units は 1 ノッチ = 120、正が上（または右）
    Wheel { vertical: bool, units: i16 },
    /// scancode は PC/AT Set 1。拡張キーは 0xE0xx
    Key { scancode: u16, down: bool },
    ReleaseAll,
}

/// セッションのスレッドへ送る指示。
pub enum Command {
    Input(Vec<RdpInput>),
    Close,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackendKind {
    /// 使えるものを自動で選ぶ（FreeRDP を優先）
    #[default]
    Auto,
    Freerdp,
    Ironrdp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConnectParams {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    /// 要求する画面サイズ（画面共有型のサーバーでは無視されることがある）
    pub width: u16,
    pub height: u16,
    #[serde(default)]
    pub backend: BackendKind,
    /// リモートの音声をローカルで鳴らす（FreeRDP のみ）
    #[serde(default)]
    pub audio: bool,
    /// ローカルのマイクをリモートへ送る（FreeRDP のみ）
    #[serde(default)]
    pub microphone: bool,
}

impl RdpConnectParams {
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(3389)
    }

    /// "DOMAIN\user" 形式も受け付けて (domain, user) に分ける
    pub fn domain_and_user(&self) -> (Option<String>, String) {
        match (&self.domain, self.username.split_once('\\')) {
            (Some(d), _) if !d.is_empty() => (Some(d.clone()), self.username.clone()),
            (_, Some((d, u))) => (Some(d.to_owned()), u.to_owned()),
            _ => (None, self.username.clone()),
        }
    }
}

/// RDP の接続方式。1 セッション = 1 スレッドで [`run`](RdpBackend::run) が呼ばれる。
pub trait RdpBackend: Sync {
    fn name(&self) -> &'static str;

    /// 接続して、切断されるまで画面の受信と入力の送信を続ける。
    /// `commands` は定期的に確認し、`Close` を受けたら切断して戻ること。
    /// 正常に終わったときは切断理由を返す。
    fn run(
        &self,
        params: &RdpConnectParams,
        commands: &Receiver<Command>,
        sink: &mut FrameSink,
    ) -> anyhow::Result<String>;
}

fn select_backend(kind: BackendKind) -> Result<&'static dyn RdpBackend, String> {
    match kind {
        #[cfg(feature = "freerdp")]
        BackendKind::Auto | BackendKind::Freerdp => Ok(&freerdp::FreeRdp),
        #[cfg(all(feature = "ironrdp", not(feature = "freerdp")))]
        BackendKind::Auto => Ok(&ironrdp::IronRdp),
        #[cfg(feature = "ironrdp")]
        BackendKind::Ironrdp => Ok(&ironrdp::IronRdp),
        #[allow(unreachable_patterns)]
        _ => Err("この RDP バックエンドは組み込まれていません".into()),
    }
}

/// フレームバッファの読み取り用ビュー。1 ピクセル 4 バイトで R, G, B, (未使用) の順。
pub struct FrameView<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

/// 変化した範囲（右下は含まない）。
#[derive(Clone, Copy)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> u32 {
        self.x + self.width
    }

    fn bottom(&self) -> u32 {
        self.y + self.height
    }

    /// 重なるか接していれば true
    fn touches(&self, o: &Rect) -> bool {
        self.x <= o.right() && o.x <= self.right() && self.y <= o.bottom() && o.y <= self.bottom()
    }

    fn union(&self, o: &Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        Rect {
            x,
            y,
            width: self.right().max(o.right()) - x,
            height: self.bottom().max(o.bottom()) - y,
        }
    }
}

/// 重なる・接する矩形どうしをまとめる（離れた矩形は別々のまま）
fn merge_rects(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut merged = true;
    while merged {
        merged = false;
        let mut i = 0;
        while i < rects.len() {
            let mut j = i + 1;
            while j < rects.len() {
                if rects[i].touches(&rects[j]) {
                    rects[i] = rects[i].union(&rects[j]);
                    rects.swap_remove(j);
                    merged = true;
                } else {
                    j += 1;
                }
            }
            i += 1;
        }
    }
    rects
}

/// バックエンドから画面側への受け口。
///
/// 変化した範囲をためておき、一定間隔でまとめてフロントへ送る。
/// 送信（WebView への受け渡し）は別スレッドで行うので、セッションのスレッドは
/// 待たされない（入力の送信が遅れない）。送信が追いつかない間は範囲をため続け、
/// 次の送信でまとめて最新の画面を送る。
///
/// 送信データ（リトルエンディアン）:
/// `画面幅 u32, 画面高さ u32, 矩形数 u32, 予備 u32, 送信時刻 f64（UNIX ミリ秒）`
/// のあとに、矩形ごとに `x, y, w, h（各 u32）` と RGBA の画素 `w*h*4` バイト。
pub struct FrameSink {
    events: Channel<RdpEvent>,
    dirty: Vec<Rect>,
    last_sent: Instant,
    /// 送信スレッドが前のデータを送っている最中
    busy: Arc<AtomicBool>,
    frames: Sender<Vec<u8>>,
}

impl FrameSink {
    fn new(events: Channel<RdpEvent>, frames: Channel<InvokeResponseBody>) -> Self {
        let busy = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let sender_busy = busy.clone();
        std::thread::spawn(move || {
            for msg in rx {
                let t0 = Instant::now();
                let kb = msg.len() / 1024;
                let _ = frames.send(InvokeResponseBody::Raw(msg));
                tracing::debug!(
                    target: "iruka_perf",
                    kb,
                    send_ms = t0.elapsed().as_secs_f64() * 1000.0,
                    "frame sent"
                );
                sender_busy.store(false, Ordering::Release);
            }
        });
        Self {
            events,
            dirty: Vec::new(),
            last_sent: Instant::now(),
            busy,
            frames: tx,
        }
    }

    /// 画面サイズが決まった・変わった。フロントは画面を作り直す。
    pub fn resize(&mut self, width: u32, height: u32) -> anyhow::Result<()> {
        self.dirty.clear();
        self.events.send(RdpEvent::Resize { width, height })?;
        Ok(())
    }

    /// 画面のこの範囲が変わった。
    pub fn damage(&mut self, rect: Rect) {
        if rect.width == 0 || rect.height == 0 {
            return;
        }
        if self.dirty.len() >= MAX_DIRTY_RECTS {
            let all = self.dirty.iter().fold(rect, |acc, r| acc.union(r));
            self.dirty.clear();
            self.dirty.push(all);
            return;
        }
        self.dirty.push(rect);
    }

    /// たまった変化を送る。`force` でなければ前回から一定時間たったときだけ送る。
    /// バックエンドはイベント処理のたびに（何もなくても定期的に）呼ぶこと。
    pub fn flush(&mut self, fb: &FrameView, force: bool) -> anyhow::Result<()> {
        if self.dirty.is_empty()
            || self.busy.load(Ordering::Acquire)
            || (!force && self.last_sent.elapsed() < FRAME_INTERVAL)
        {
            return Ok(());
        }
        let t0 = Instant::now();
        let rects: Vec<Rect> = merge_rects(std::mem::take(&mut self.dirty))
            .into_iter()
            .filter_map(|r| {
                // 画面外にはみ出した分を切り詰める
                let right = r.right().min(fb.width);
                let bottom = r.bottom().min(fb.height);
                (right > r.x && bottom > r.y).then(|| Rect {
                    x: r.x,
                    y: r.y,
                    width: right - r.x,
                    height: bottom - r.y,
                })
            })
            .collect();
        if rects.is_empty() {
            return Ok(());
        }

        let pixels: usize = rects.iter().map(|r| r.width as usize * r.height as usize * 4).sum();
        let mut msg = Vec::with_capacity(24 + rects.len() * 16 + pixels);
        let sent_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        for v in [fb.width, fb.height, rects.len() as u32, 0] {
            msg.extend_from_slice(&v.to_le_bytes());
        }
        msg.extend_from_slice(&sent_at.to_le_bytes());
        for r in &rects {
            for v in [r.x, r.y, r.width, r.height] {
                msg.extend_from_slice(&v.to_le_bytes());
            }
            let start = msg.len();
            for row in r.y..r.bottom() {
                let offset = row as usize * fb.stride + r.x as usize * 4;
                msg.extend_from_slice(&fb.data[offset..offset + r.width as usize * 4]);
            }
            // アルファは常に不透明として扱う
            for a in msg[start..].iter_mut().skip(3).step_by(4) {
                *a = 0xff;
            }
        }
        tracing::debug!(
            target: "iruka_perf",
            rects = rects.len(),
            kb = msg.len() / 1024,
            copy_ms = t0.elapsed().as_secs_f64() * 1000.0,
            "frame queued"
        );
        self.busy.store(true, Ordering::Release);
        if self.frames.send(msg).is_err() {
            self.busy.store(false, Ordering::Release);
        }
        self.last_sent = Instant::now();
        Ok(())
    }
}

#[derive(Default)]
pub struct RdpState {
    sessions: Arc<Mutex<HashMap<u32, Sender<Command>>>>,
}

#[tauri::command]
pub fn rdp_connect(
    state: tauri::State<'_, RdpState>,
    params: RdpConnectParams,
    on_event: Channel<RdpEvent>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let backend = select_backend(params.backend)?;
    let id = NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    state.sessions.lock().unwrap().insert(id, tx);

    let sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let mut sink = FrameSink::new(on_event.clone(), on_frame);
        let (reason, error) = match backend.run(&params, &rx, &mut sink) {
            Ok(reason) => (reason, false),
            Err(e) => (format!("{e:#}"), true),
        };
        sessions.lock().unwrap().remove(&id);
        let _ = on_event.send(RdpEvent::Closed {
            reason,
            error,
            backend: backend.name(),
        });
    });

    Ok(id)
}

#[tauri::command]
pub fn rdp_input(state: tauri::State<'_, RdpState>, id: u32, events: Vec<RdpInput>) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let tx = sessions.get(&id).ok_or("session not found")?;
    let keys = events.iter().filter(|e| matches!(e, RdpInput::Key { down: true, .. })).count();
    if keys > 0 {
        tracing::debug!(target: "iruka_perf", keys, total = events.len(), "input received from frontend");
    }
    tx.send(Command::Input(events)).map_err(|e| e.to_string())
}

/// フロント側の性能計測結果をログに出す（調査用）
#[tauri::command]
pub fn rdp_perf_log(message: String) {
    tracing::debug!(target: "iruka_perf", "frontend: {message}");
}

#[tauri::command]
pub fn rdp_close(state: tauri::State<'_, RdpState>, id: u32) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(tx) = sessions.get(&id) {
        let _ = tx.send(Command::Close);
    }
    Ok(())
}
