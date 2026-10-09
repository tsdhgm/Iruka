//! RDP セッションに必要なメモリ量の見積もり。
//!
//! 1 セッションの必要量を「固定分 + 1 ピクセルあたりの量 × 画素数」とみなす。
//! 固定分と 1 ピクセルあたりの量の比は実測（1080p と 4K）で決めておき、
//! 実際の使い方に合わせるのは全体の倍率だけにする。こうすると、
//! どの解像度の接続から学んでも、ほかの解像度に当てはめられる。
//!
//! 数秒ごとに Iruka 全体（本体 + WebView などの子プロセス）のメモリ使用量と、
//! 開いている RDP セッションの数と画素数の合計を記録し、
//! 「(使用量 − RDP なしのときの使用量) ÷ 標準の式での必要量」= 倍率を学習する。
//! 見積もりには観測値の上位 5% を使う（画面が大きく変わったときの山も含めるため）。
//! 学習した値はファイルに保存し、次回の起動でも使う。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::Manager;

/// 記録する間隔
const SAMPLE_INTERVAL: Duration = Duration::from_secs(3);
/// 起動直後のこの時間は基準値に使わない（WebView の読み込み中で使用量が低く出る）
const WARMUP: Duration = Duration::from_secs(15);
/// 保存しておく観測値の数（3 秒ごとで約 1 時間分）
const MAX_SAMPLES: usize = 1200;
/// 1 セッションの固定分（2026-10 の実測：FreeRDP、省メモリ、Iruka 全体で計測）
const BASE_SESSION_BYTES: f64 = 150.0 * 1_048_576.0;
/// 1 ピクセルあたりの量（同上。1080p で約 290MB、4K で約 700MB）
const BASE_BYTES_PER_PIXEL: f64 = 66.0;
/// 見積もりに使う観測値の位置（上位 5%）
const PERCENTILE: f64 = 0.95;
/// 学習した値を使い始めるのに必要な観測数
const MIN_SAMPLES: usize = 20;
/// 見積もりに足すゆとり
const SAFETY_FACTOR: f64 = 1.2;
/// 保存する間隔
const SAVE_INTERVAL: Duration = Duration::from_secs(60);

/// 開いている RDP セッションの画面サイズ（接続中は要求したサイズ、接続後は実際のサイズ）
static SESSION_SIZES: LazyLock<Mutex<HashMap<u32, (u32, u32)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static MODEL: LazyLock<Mutex<Model>> = LazyLock::new(|| Mutex::new(Model::default()));

pub fn set_session_size(id: u32, width: u32, height: u32) {
    SESSION_SIZES.lock().unwrap().insert(id, (width, height));
}

pub fn remove_session(id: u32) {
    SESSION_SIZES.lock().unwrap().remove(&id);
}

/// 標準の式での必要量（倍率 1 のとき）
fn base_estimate(sessions: u64, pixels: u64) -> f64 {
    BASE_SESSION_BYTES * sessions as f64 + BASE_BYTES_PER_PIXEL * pixels as f64
}

#[derive(Default, Serialize, Deserialize)]
struct Model {
    /// 倍率の観測値（古いものから順）
    #[serde(default)]
    scales: Vec<f64>,
    /// この起動で RDP セッションがないときに観測した、いちばん小さい使用量
    #[serde(skip)]
    baseline: Option<u64>,
}

impl Model {
    fn learned(&self) -> bool {
        self.scales.len() >= MIN_SAMPLES
    }

    fn scale(&self) -> f64 {
        if !self.learned() {
            return 1.0;
        }
        let mut sorted = self.scales.clone();
        sorted.sort_by(f64::total_cmp);
        let idx = ((sorted.len() - 1) as f64 * PERCENTILE).round() as usize;
        sorted[idx]
    }

    /// 解像度 width × height の接続 1 本に必要と見込む量（ゆとり込み）
    fn estimate(&self, width: u32, height: u32) -> u64 {
        (base_estimate(1, width as u64 * height as u64) * self.scale() * SAFETY_FACTOR) as u64
    }

    fn record(&mut self, used: u64, sessions: u64, pixels: u64, warmed_up: bool) {
        if sessions == 0 {
            if warmed_up {
                self.baseline = Some(self.baseline.map_or(used, |b| b.min(used)));
            }
            return;
        }
        let Some(baseline) = self.baseline else { return };
        let scale = used.saturating_sub(baseline) as f64 / base_estimate(sessions, pixels);
        self.scales.push(scale);
        if self.scales.len() > MAX_SAMPLES {
            let excess = self.scales.len() - MAX_SAMPLES;
            self.scales.drain(..excess);
        }
    }
}

/// Iruka 本体と、その子孫プロセス（WebView など）のメモリ使用量の合計
fn process_tree_memory(sys: &System, root: Pid) -> u64 {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in sys.processes() {
        // Linux ではスレッドもプロセスとして見えるので除く（数えると重複する）
        if p.thread_kind().is_some() {
            continue;
        }
        if let Some(parent) = p.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }
    let mut total = 0;
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if let Some(p) = sys.process(pid) {
            total += p.memory();
        }
        if let Some(c) = children.get(&pid) {
            stack.extend(c);
        }
    }
    total
}

fn model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("memory-model.json"))
}

fn load(path: &PathBuf) -> Option<Model> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn save(path: &PathBuf, model: &Model) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(model) {
        let _ = std::fs::write(path, json);
    }
}

/// 学習用の記録を始める（起動時に 1 回呼ぶ）
pub fn start(app: &tauri::AppHandle) {
    let path = model_path(app);
    if let Some(saved) = path.as_ref().and_then(load) {
        MODEL.lock().unwrap().scales = saved.scales;
    }
    std::thread::spawn(move || {
        let me = Pid::from_u32(std::process::id());
        let mut sys = System::new();
        let started = Instant::now();
        let mut last_save = Instant::now();
        loop {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            let used = process_tree_memory(&sys, me);
            let (sessions, pixels) = {
                let sizes = SESSION_SIZES.lock().unwrap();
                let pixels = sizes.values().map(|&(w, h)| w as u64 * h as u64).sum();
                (sizes.len() as u64, pixels)
            };
            let mut model = MODEL.lock().unwrap();
            model.record(used, sessions, pixels, started.elapsed() >= WARMUP);
            tracing::debug!(
                target: "iruka_mem",
                used_mb = used / 1_048_576,
                baseline_mb = model.baseline.map(|b| b / 1_048_576),
                sessions,
                pixels,
                scale = model.scale(),
                samples = model.scales.len(),
                "memory sample"
            );
            if last_save.elapsed() >= SAVE_INTERVAL {
                if let Some(path) = &path {
                    save(path, &model);
                }
                last_save = Instant::now();
            }
            drop(model);
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCheck {
    /// OS が「今すぐ使える」とするメモリ量
    available_bytes: u64,
    /// この接続に必要と見込む量（ゆとり込み）
    estimated_bytes: u64,
    /// 標準の式に掛けている倍率（学習前は 1）
    scale: f64,
    /// 学習した値を使ったか（false なら初期値）
    learned: bool,
}

/// 新しい RDP 接続（width × height）に必要なメモリの見積もりと、空きメモリ
#[tauri::command]
pub fn rdp_memory_check(width: u32, height: u32) -> MemoryCheck {
    let mut sys = System::new();
    sys.refresh_memory();
    let model = MODEL.lock().unwrap();
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut available_bytes = sys.available_memory();
    // 開発中の確認用：IRUKA_FAKE_AVAILABLE_MB で空きメモリを小さく見せる
    #[cfg(debug_assertions)]
    if let Some(mb) = std::env::var("IRUKA_FAKE_AVAILABLE_MB").ok().and_then(|v| v.parse::<u64>().ok()) {
        available_bytes = mb * 1_048_576;
    }
    MemoryCheck {
        available_bytes,
        estimated_bytes: model.estimate(width, height),
        scale: model.scale(),
        learned: model.learned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1_048_576;

    #[test]
    fn learns_scale_from_observations() {
        let mut m = Model::default();
        // 起動直後の低い値は基準にしない
        m.record(400 * MB, 0, 0, false);
        m.record(500 * MB, 0, 0, true);
        assert_eq!(m.baseline, Some(500 * MB));
        assert!(!m.learned());
        // 標準の式どおりの 2 倍を使い続けたら、倍率は 2 になる
        for _ in 0..MIN_SAMPLES {
            let used = 500 * MB + (2.0 * base_estimate(1, 1920 * 1080)) as u64;
            m.record(used, 1, 1920 * 1080, true);
        }
        assert!(m.learned());
        assert!((m.scale() - 2.0).abs() < 1e-6);
        // 4K の見積もり = 2 倍 ×（固定分 + 画素分）× ゆとり
        let expect = 2.0 * base_estimate(1, 3840 * 2160) * SAFETY_FACTOR;
        assert!((m.estimate(3840, 2160) as f64 - expect).abs() < 1.0);
    }
}
