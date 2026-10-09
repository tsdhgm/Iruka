//! ローカルの OS のクリップボードと、RDP セッションのクリップボード（テキストのみ）をつなぐ。
//!
//! 20 台以上を同時に開くので、同期するのは表示中（アクティブ）のセッションだけにする。
//! - ローカル → リモート: セッションが前面に来たとき（リモート画面にフォーカスが入ったとき）に、
//!   ローカルのテキストをそのセッションへ渡す。
//! - リモート → ローカル: アクティブなセッションでコピーされたテキストだけをローカルに入れる。
//!   裏のセッションでのコピーは無視する（ローカルのクリップボードを勝手に上書きしない）。
//!
//! OS ごとの違いは arboard が吸収する（Windows / macOS / Linux の X11。
//! Wayland の GNOME では XWayland 経由で同期される）。

use std::sync::{
    atomic::{AtomicU32, Ordering},
    LazyLock, Mutex,
};

/// アクティブな RDP セッションがないことを表す値
const NONE: u32 = u32::MAX;

static ACTIVE: AtomicU32 = AtomicU32::new(NONE);

/// Linux（X11）では、クリップボードの持ち主のオブジェクトが生きている間だけ
/// 他のアプリに中身を渡せるので、起動中ずっと 1 つを持ち続ける。
static CLIPBOARD: LazyLock<Mutex<Option<arboard::Clipboard>>> =
    LazyLock::new(|| Mutex::new(arboard::Clipboard::new().ok()));

/// アクティブな RDP セッションを設定する（None はコンソールなど RDP 以外を表示中）。
pub fn set_active(id: Option<u32>) {
    ACTIVE.store(id.unwrap_or(NONE), Ordering::Relaxed);
}

/// ローカルのクリップボードのテキスト（なければ None）。改行はリモート向け（CRLF）にする。
pub fn local_text() -> Option<String> {
    let text = CLIPBOARD.lock().unwrap().as_mut()?.get_text().ok()?;
    Some(to_crlf(&text))
}

/// セッション `id` でコピーされたテキストを、アクティブならローカルのクリップボードに入れる。
pub fn from_remote(id: u32, text: &str) {
    if ACTIVE.load(Ordering::Relaxed) != id {
        return;
    }
    let text = if cfg!(windows) { text.to_owned() } else { text.replace("\r\n", "\n") };
    if let Some(clipboard) = CLIPBOARD.lock().unwrap().as_mut() {
        if let Err(e) = clipboard.set_text(text) {
            tracing::warn!("ローカルのクリップボードに書き込めませんでした: {e}");
        }
    }
}

/// 改行を CRLF にそろえる（Windows の CF_UNICODETEXT の流儀）
fn to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newlines_become_crlf_once() {
        assert_eq!(to_crlf("a\nb\r\nc"), "a\r\nb\r\nc");
    }
}
