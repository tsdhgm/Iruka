use std::sync::atomic::AtomicU32;

mod pty;
mod rdp;

/// コンソールと RDP で共通のセッション ID（フロントでは 1 つの一覧で扱うため）。
pub(crate) static NEXT_SESSION_ID: AtomicU32 = AtomicU32::new(0);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // RDP 接続の調査用ログ（IRUKA_LOG で上書き可）
    let filter = tracing_subscriber::EnvFilter::try_from_env("IRUKA_LOG").unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("warn,ironrdp_connector=debug,ironrdp_blocking=debug,iruka_lib=debug,iruka_perf=debug")
    });
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(rdp::RdpState::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_session,
            pty::write_session,
            pty::resize_session,
            pty::kill_session,
            rdp::rdp_connect,
            rdp::rdp_input,
            rdp::rdp_close,
            rdp::rdp_perf_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
