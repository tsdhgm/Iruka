mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_session,
            pty::write_session,
            pty::resize_session,
            pty::kill_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
