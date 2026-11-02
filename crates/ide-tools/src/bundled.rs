//! Versioned app-owned tools, shared by tool detection, language-server and debugger launches:
//! plugin jars written as they are, Python wheels unpacked into `<tool>/lib` (no pip, no network).

use crate::{Method, ToolSpec};
use std::path::{Path, PathBuf};

pub(crate) fn install(root: &Path, spec: &ToolSpec) -> std::io::Result<PathBuf> {
    let Method::Bundled { filename, bytes, .. } = spec.method else { unreachable!("bundled tool") };
    if filename.ends_with(".whl") {
        return install_wheel(root, spec.name, filename, bytes);
    }
    let dir = root.join(spec.name).join("bin");
    // The agent path participates in the JDT LS workspace key: upgrades must
    // discard incremental state compiled with the previous agent.
    let path = dir.join(filename);
    if std::fs::read(&path).is_ok_and(|old| old == bytes) {
        return Ok(path);
    }
    std::fs::create_dir_all(&dir)?;
    let temporary = dir.join(format!(".{filename}-{}.tmp", unique()));
    let result = std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        // Another window may have installed the same bytes concurrently.
        if !std::fs::read(&path).is_ok_and(|old| old == bytes) {
            tracing::warn!(tool = spec.name, %error, "Bundled plugin unavailable");
            return Err(error);
        }
    }
    Ok(path)
}

fn unique() -> String {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{}-{nonce}", std::process::id())
}

/// Unpacks a pure-Python wheel into `<root>/<name>/lib` (where `ide-dap` puts debugpy's
/// private copy on `PYTHONPATH`), replacing what is there. A stamp named after the wheel
/// marks a complete unpacking of these bytes.
fn install_wheel(root: &Path, name: &str, filename: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let dir = root.join(name);
    let lib = dir.join("lib");
    let stamp = format!(".{filename}");
    if lib.join(&stamp).is_file() {
        return Ok(lib);
    }
    std::fs::create_dir_all(&dir)?;
    let staging = dir.join(format!(".lib-{}", unique()));
    let result = unpack(bytes, &staging).and_then(|()| std::fs::write(staging.join(&stamp), filename));
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&staging);
        tracing::warn!(tool = name, %error, "Bundled wheel unavailable");
        return Err(error);
    }
    // A previous copy (an older wheel, a pip install) moves aside first: renames don't replace folders.
    let old = dir.join(format!(".old-{}", unique()));
    let moved = lib.exists() && std::fs::rename(&lib, &old).is_ok();
    let swapped = std::fs::rename(&staging, &lib);
    let _ = std::fs::remove_dir_all(&staging);
    if moved {
        let _ = std::fs::remove_dir_all(&old);
    }
    match swapped {
        Ok(()) => Ok(lib),
        // Another window unpacked the same wheel meanwhile.
        Err(_) if lib.join(&stamp).is_file() => Ok(lib),
        Err(error) => Err(error),
    }
}

fn unpack(bytes: &[u8], into: &Path) -> std::io::Result<()> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(std::io::Error::other)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(std::io::Error::other)?;
        let Some(relative) = entry.enclosed_name() else { continue };
        let path = into.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::io::copy(&mut entry, &mut std::fs::File::create(&path)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_debugpy_wheel_unpacks_once_into_lib() {
        let root = tempfile::tempdir().unwrap();
        let spec = crate::registry::find("debugpy").unwrap();
        let lib = install(root.path(), spec).unwrap();
        assert_eq!(lib, root.path().join("debugpy").join("lib"));
        assert!(lib.join("debugpy").join("__init__.py").is_file());
        assert!(lib.join("debugpy").join("adapter").join("__main__.py").is_file());
        // A second call keeps the copy; a stale one (an older pip install) is replaced.
        std::fs::write(lib.join("marker"), "").unwrap();
        install(root.path(), spec).unwrap();
        assert!(lib.join("marker").is_file());
        let stamp =
            std::fs::read_dir(&lib).unwrap().flatten().find(|e| e.file_name().to_string_lossy().ends_with(".whl"));
        std::fs::remove_file(stamp.unwrap().path()).unwrap();
        install(root.path(), spec).unwrap();
        assert!(!lib.join("marker").exists());
        assert!(lib.join("debugpy").join("__init__.py").is_file());
    }
}
