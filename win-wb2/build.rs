use std::env;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=build.rs");

    if env::var_os("CARGO_CFG_WINDOWS").is_some()
        || env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .ok_or("win-wb2 has no repository root")?;
        let icon_path = repo_root.join("resources").join("win").join("jellyfin.ico");
        println!("cargo:rerun-if-changed={}", icon_path.display());

        let rc_path = PathBuf::from(env::var("OUT_DIR")?).join("jellium-wb2-icon.rc");
        let icon_path = icon_path.to_string_lossy().replace('\\', "/");
        fs::write(&rc_path, format!("IDI_ICON1 ICON \"{icon_path}\"\n"))?;
        embed_resource::compile(&rc_path, embed_resource::NONE).manifest_required()?;

        if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            println!("cargo:rustc-link-arg-bins=/SUBSYSTEM:WINDOWS");
            println!("cargo:rustc-link-arg-bins=/ENTRY:mainCRTStartup");
        }
    }

    Ok(())
}
