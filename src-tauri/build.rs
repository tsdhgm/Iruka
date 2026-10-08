fn main() {
    #[cfg(feature = "freerdp")]
    build_freerdp_bridge();

    tauri_build::build()
}

/// FreeRDP 3 との橋渡し（native/freerdp_bridge.c）をビルドしてリンクする。
#[cfg(feature = "freerdp")]
fn build_freerdp_bridge() {
    println!("cargo:rerun-if-changed=native/freerdp_bridge.c");
    let lib = pkg_config::Config::new()
        .atleast_version("3.0")
        .probe("freerdp-client3")
        .expect("FreeRDP 3 が見つかりません（Ubuntu なら: sudo apt install freerdp3-dev）");
    let mut build = cc::Build::new();
    build
        .file("native/freerdp_bridge.c")
        .warnings(true)
        // FreeRDP / WinPR のヘッダ自身が出す非推奨警告は抑える
        .flag_if_supported("-Wno-deprecated-declarations");
    for path in &lib.include_paths {
        build.include(path);
    }
    build.compile("iruka_freerdp_bridge");
}
