use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::Ordering,
        Arc, Mutex,
    },
};

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    #[serde(rename_all = "camelCase")]
    Output { data: String },
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<u32> },
}

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
}

#[tauri::command]
pub fn spawn_session(
    state: tauri::State<'_, PtyState>,
    program: Option<String>,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let program = program
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "bash".into());
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = crate::NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    state.sessions.lock().unwrap().insert(
        id,
        Session {
            writer,
            master: pair.master,
            killer,
        },
    );

    // Stream PTY output to the frontend.
    let out_channel = on_event.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if out_channel.send(PtyEvent::Output { data }).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Reap the child and notify the frontend when it exits.
    let sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        sessions.lock().unwrap().remove(&id);
        let _ = on_event.send(PtyEvent::Exit { code });
    });

    Ok(id)
}

#[tauri::command]
pub fn write_session(state: tauri::State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_session(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_session(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session.killer.kill().map_err(|e| e.to_string())
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}
