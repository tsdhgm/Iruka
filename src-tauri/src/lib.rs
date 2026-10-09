use std::sync::atomic::AtomicU32;

mod clipboard;
mod memory;
mod pty;
mod rdp;

/// コンソールと RDP で共通のセッション ID（フロントでは 1 つの一覧で扱うため）。
pub(crate) static NEXT_SESSION_ID: AtomicU32 = AtomicU32::new(0);

/// glibc の malloc に、大きな確保（画面データなど）を毎回 OS から直接取って、
/// 解放したらすぐ返すよう指示する。
///
/// 既定では、大きな領域を一度解放すると閾値が最大 32MB まで自動で上がり、
/// 以後の数 MB〜数十 MB の確保がスレッドごとのヒープ（64MB 単位）に置かれて、
/// 解放後も返されずに残る。4K の画面データを多数のスレッドで扱うと、
/// これだけで GB 単位になる。
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn tune_malloc() {
    const M_MMAP_THRESHOLD: std::ffi::c_int = -3;
    extern "C" {
        fn mallopt(param: std::ffi::c_int, value: std::ffi::c_int) -> std::ffi::c_int;
    }
    // 明示的に設定すると、閾値の自動調整は止まる
    unsafe {
        mallopt(M_MMAP_THRESHOLD, 256 * 1024);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    tune_malloc();

    // RDP 接続の調査用ログ（IRUKA_LOG で上書き可）
    let filter = tracing_subscriber::EnvFilter::try_from_env("IRUKA_LOG").unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("warn,ironrdp_connector=debug,ironrdp_blocking=debug,iruka_lib=debug,iruka_perf=debug,iruka_mem=debug")
    });
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(rdp::RdpState::default())
        .setup(|app| {
            memory::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_session,
            pty::write_session,
            pty::resize_session,
            pty::kill_session,
            rdp::rdp_connect,
            rdp::rdp_input,
            rdp::rdp_close,
            rdp::rdp_perf_log,
            rdp::rdp_set_active,
            memory::rdp_memory_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
