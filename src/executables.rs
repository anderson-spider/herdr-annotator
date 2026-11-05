//! Desktop apps do not inherit interactive-shell tool paths. Prefer installer
//! discoveries, then PATH and known user install locations. Never source a shell.
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

fn executable(path: &Path) -> bool {
    path.is_absolute()
        && path
            .metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn receipt(key: &str) -> Option<Value> {
    env::var_os("HOME")
        .and_then(|home| {
            std::fs::read(PathBuf::from(home).join(".local/share/herdr-annotator/install.json"))
                .ok()
        })
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get(key).cloned())
}

fn installed() -> BTreeMap<String, PathBuf> {
    receipt("tools")
        .and_then(|tools| serde_json::from_value(tools).ok())
        .unwrap_or_default()
}

/// Self-hosted GitLab hosts recorded by `install.py --gitlab-host`.
pub(crate) fn gitlab_hosts() -> Vec<String> {
    receipt("gitlab_hosts")
        .and_then(|hosts| serde_json::from_value(hosts).ok())
        .unwrap_or_default()
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<_> = env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        for relative in [
            ".opencode/bin",
            ".local/bin",
            "Library/pnpm/bin",
            ".local/share/pnpm",
            ".local/share/fnm/aliases/default/bin",
            ".fnm/aliases/default/bin",
        ] {
            dirs.push(home.join(relative));
        }
    }
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    dirs
}

pub(crate) fn tool(name: &str, override_name: &str) -> PathBuf {
    if let Some(path) = env::var_os(override_name) {
        return path.into();
    }
    if let Some(path) = installed().get(name).filter(|path| executable(path)) {
        return path.clone();
    }
    search_dirs()
        .iter()
        .map(|dir| dir.join(name))
        .find(|path| executable(path))
        .unwrap_or_else(|| name.into())
}

pub(crate) fn runtime_path() -> std::ffi::OsString {
    let mut dirs: Vec<_> = installed()
        .values()
        .filter(|path| executable(path))
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect();
    dirs.extend(search_dirs());
    // Pass this explicitly through hc exec: core has its own process environment.
    env::join_paths(dirs).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}
