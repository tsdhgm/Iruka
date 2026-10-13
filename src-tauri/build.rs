fn main() {
    #[cfg(feature = "freerdp")]
    build_freerdp_bridge();

    tauri_build::build()
}

/// Build and link the FreeRDP 3 bridge (native/freerdp_bridge.c).
#[cfg(feature = "freerdp")]
fn build_freerdp_bridge() {
    println!("cargo:rerun-if-changed=native/freerdp_bridge.c");
    let lib = pkg_config::Config::new()
        .atleast_version("3.0")
        .probe("freerdp-client3")
        .expect("FreeRDP 3 not found (on Ubuntu: sudo apt install freerdp3-dev)");
    let mut build = cc::Build::new();
    build
        .file("native/freerdp_bridge.c")
        .warnings(true)
        // Silence deprecation warnings coming from the FreeRDP / WinPR headers themselves
        .flag_if_supported("-Wno-deprecated-declarations");
    for path in &lib.include_paths {
        build.include(path);
    }
    build.compile("iruka_freerdp_bridge");
}
