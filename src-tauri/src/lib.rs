use std::sync::atomic::AtomicU32;

mod clipboard;
mod memory;
mod pty;
mod rdp;

/// Session ID shared by consoles and RDP sessions (the frontend keeps them in a single list).
pub(crate) static NEXT_SESSION_ID: AtomicU32 = AtomicU32::new(0);

/// Tell glibc's malloc to take large allocations (such as screen data) directly from
/// the OS every time and to hand them back as soon as they are freed.
///
/// By default, once a large region is freed the threshold is raised automatically
/// (up to 32MB); from then on allocations of a few MB to a few tens of MB land in
/// the per-thread heaps (64MB arenas) and stay there even after being freed. With
/// 4K screen data handled on many threads, this alone adds up to gigabytes.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn tune_malloc() {
    const M_MMAP_THRESHOLD: std::ffi::c_int = -3;
    extern "C" {
        fn mallopt(param: std::ffi::c_int, value: std::ffi::c_int) -> std::ffi::c_int;
    }
    // Setting it explicitly disables the automatic threshold adjustment.
    // SAFETY: mallopt is a plain glibc call taking two integers; it touches no memory
    // we own and only changes allocator tuning parameters.
    unsafe {
        mallopt(M_MMAP_THRESHOLD, 256 * 1024);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    tune_malloc();

    // Diagnostic logging for RDP connections (override with IRUKA_LOG)
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
            rdp::rdp_is_self,
            memory::rdp_memory_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
