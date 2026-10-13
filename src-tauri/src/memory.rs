//! Estimates how much memory an RDP session needs.
//!
//! The requirement of one session is modeled as "fixed part + per-pixel amount x pixel count".
//! The ratio between the fixed part and the per-pixel amount was fixed from measurements
//! (1080p and 4K); only an overall scale factor is fitted to actual usage. That way,
//! whatever resolution the model learns from, the result carries over to other resolutions.
//!
//! Every few seconds the memory usage of Iruka as a whole (main process + child processes
//! such as the WebView) is recorded together with the number of open RDP sessions and
//! their total pixel count, and the scale factor
//! "(usage - usage with no RDP sessions) / requirement from the standard formula" is learned.
//! The estimate uses the 95th percentile of the observations (so that spikes from large
//! screen changes are included). The learned value is saved to a file and reused on the next launch.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::Manager;

/// Sampling interval
const SAMPLE_INTERVAL: Duration = Duration::from_secs(3);
/// Samples this soon after launch are not used for the baseline (usage reads low while the WebView is still loading)
const WARMUP: Duration = Duration::from_secs(15);
/// Number of observations to keep (about one hour at one every 3 seconds)
const MAX_SAMPLES: usize = 1200;
/// Fixed part per session (measured 2026-10: FreeRDP, low-memory mode, Iruka as a whole)
const BASE_SESSION_BYTES: f64 = 150.0 * 1_048_576.0;
/// Per-pixel amount (same measurement; about 290MB at 1080p, about 700MB at 4K)
const BASE_BYTES_PER_PIXEL: f64 = 66.0;
/// Percentile of the observations used for the estimate (top 5%)
const PERCENTILE: f64 = 0.95;
/// Number of observations required before the learned value is used
const MIN_SAMPLES: usize = 20;
/// Safety margin applied to the estimate
const SAFETY_FACTOR: f64 = 1.2;
/// Save interval
const SAVE_INTERVAL: Duration = Duration::from_secs(60);

/// Screen sizes of the open RDP sessions (the requested size while connecting, the actual size once connected)
static SESSION_SIZES: LazyLock<Mutex<HashMap<u32, (u32, u32)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static MODEL: LazyLock<Mutex<Model>> = LazyLock::new(|| Mutex::new(Model::default()));

pub fn set_session_size(id: u32, width: u32, height: u32) {
    SESSION_SIZES.lock().unwrap().insert(id, (width, height));
}

pub fn remove_session(id: u32) {
    SESSION_SIZES.lock().unwrap().remove(&id);
}

/// Requirement from the standard formula (with a scale factor of 1)
fn base_estimate(sessions: u64, pixels: u64) -> f64 {
    BASE_SESSION_BYTES * sessions as f64 + BASE_BYTES_PER_PIXEL * pixels as f64
}

#[derive(Default, Serialize, Deserialize)]
struct Model {
    /// Observed scale factors (oldest first)
    #[serde(default)]
    scales: Vec<f64>,
    /// Lowest usage observed during this run while no RDP session was open
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

    /// Expected requirement of one connection at width x height (including the safety margin)
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

/// Total memory usage of the Iruka process and its descendants (WebView etc.)
fn process_tree_memory(sys: &System, root: Pid) -> u64 {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in sys.processes() {
        // On Linux threads show up as processes too; skip them (they would be counted twice)
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

/// Start recording samples for learning (call once at startup)
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
    /// Memory the OS reports as available right now
    available_bytes: u64,
    /// Expected requirement of this connection (including the safety margin)
    estimated_bytes: u64,
    /// Scale factor applied to the standard formula (1 before learning)
    scale: f64,
    /// Whether the learned value was used (false means the initial value)
    learned: bool,
}

/// Estimated memory for a new RDP connection (width x height), and the available memory
#[tauri::command]
pub fn rdp_memory_check(width: u32, height: u32) -> MemoryCheck {
    let mut sys = System::new();
    sys.refresh_memory();
    let model = MODEL.lock().unwrap();
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut available_bytes = sys.available_memory();
    // For testing during development: IRUKA_FAKE_AVAILABLE_MB makes the available memory look smaller
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
        // Low values right after launch are not used as the baseline
        m.record(400 * MB, 0, 0, false);
        m.record(500 * MB, 0, 0, true);
        assert_eq!(m.baseline, Some(500 * MB));
        assert!(!m.learned());
        // Keep using exactly twice the standard formula; the scale factor becomes 2
        for _ in 0..MIN_SAMPLES {
            let used = 500 * MB + (2.0 * base_estimate(1, 1920 * 1080)) as u64;
            m.record(used, 1, 1920 * 1080, true);
        }
        assert!(m.learned());
        assert!((m.scale() - 2.0).abs() < 1e-6);
        // 4K estimate = 2 x (fixed part + pixel part) x safety margin
        let expect = 2.0 * base_estimate(1, 3840 * 2160) * SAFETY_FACTOR;
        assert!((m.estimate(3840, 2160) as f64 - expect).abs() < 1.0);
    }
}
