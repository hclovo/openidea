//! `~/.ssh/config` as OpenSSH reads it, for what russh-config does not do:
//! `Include` files (inlined where they appear; relative to `~/.ssh`, with `*` /
//! `?` in file names), directives before the first `Host` (they apply to every
//! host), and `Key=Value` or tab-separated lines; `Match` blocks are left out.
//! Its concrete `Host` aliases are the hosts Remote Development lists without a
//! configuration of their own.

use ide_core::remote_settings::{SshAuth, SshConfiguration};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// Id prefix of the configuration standing for a `~/.ssh/config` host.
pub const ID_PREFIX: &str = "ssh-config:";

/// How deep `Include`d files may include others.
const MAX_DEPTH: usize = 8;

/// A `Host` of `~/.ssh/config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// The configuration connecting to it: the alias, with OpenSSH config and agent authentication.
    pub config: SshConfiguration,
    /// Where it leads: `user@hostname:port`.
    pub target: String,
    /// The `ProxyJump` hosts on the way, as written.
    pub proxy_jump: Option<String>,
}

/// The configuration of `~/.ssh/config` host `alias`.
pub fn configuration(alias: &str) -> SshConfiguration {
    SshConfiguration {
        id: format!("{ID_PREFIX}{alias}"),
        name: alias.to_owned(),
        host: alias.to_owned(),
        auth: SshAuth::OpenSsh,
        ..Default::default()
    }
}

/// The config file with its includes inlined, in the form russh-config parses
/// (`None` when it cannot be read).
pub fn read(path: &Path) -> Option<String> {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut out = Flattened::default();
    out.file(path, &dir, 0).then_some(out.text)
}

#[derive(Default)]
struct Flattened {
    text: String,
    /// A `Host` / `Match` block has begun: later directives belong to it.
    in_block: bool,
}

impl Flattened {
    /// Appends `path`; `false` when it cannot be read.
    fn file(&mut self, path: &Path, dir: &Path, depth: usize) -> bool {
        let Ok(text) = std::fs::read_to_string(path) else { return false };
        for line in text.lines() {
            let Some((key, value)) = split_directive(line) else { continue };
            let lower = key.to_ascii_lowercase();
            if lower == "include" {
                if depth < MAX_DEPTH {
                    for file in words(value).iter().flat_map(|w| include_files(w, dir)) {
                        self.file(&file, dir, depth + 1);
                    }
                }
                continue;
            }
            if lower == "match" {
                // russh-config has no `Match`: its directives must not reach the
                // `Host` before it, so the block matches no host here.
                self.text.push_str("Host !*\n");
                self.in_block = true;
                continue;
            }
            if lower == "host" {
                self.in_block = true;
            } else if !self.in_block {
                // OpenSSH applies directives before the first block to every host.
                self.text.push_str("Host *\n");
                self.in_block = true;
            }
            self.text.push_str(key);
            self.text.push(' ');
            self.text.push_str(value);
            self.text.push('\n');
        }
        true
    }
}

/// `Keyword value`, `Keyword=value` or `Keyword\tvalue`; `None` for blank lines and comments.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let (key, rest) = line.split_at(end);
    let value = rest.trim_start().strip_prefix('=').unwrap_or(rest).trim();
    Some((key, value))
}

/// Space-separated words, `"…"` quoting spaces.
fn words(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// The files of an `Include` argument: `~/` is the home folder, a relative
/// path is in `dir` (`~/.ssh`), and the file name may hold `*` and `?`.
fn include_files(arg: &str, dir: &Path) -> Vec<PathBuf> {
    let path = match arg.strip_prefix("~/") {
        Some(rest) => crate::target::home().unwrap_or_default().join(rest),
        None if Path::new(arg).is_absolute() => PathBuf::from(arg),
        None => dir.join(arg),
    };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return Vec::new() };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(parent) = path.parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(parent) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| wildcard(name, n)))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    files
}

/// `*` and `?` matching of a whole name.
fn wildcard(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match p.split_first() {
            None => n.is_empty(),
            Some(('*', rest)) => (0..=n.len()).any(|i| go(rest, &n[i..])),
            Some(('?', rest)) => !n.is_empty() && go(rest, &n[1..]),
            Some((c, rest)) => n.first() == Some(c) && go(rest, &n[1..]),
        }
    }
    go(&pattern.chars().collect::<Vec<_>>(), &name.chars().collect::<Vec<_>>())
}

/// The concrete aliases of `Host` lines, in order: not patterns or negations.
pub fn aliases(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = split_directive(line) else { continue };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for alias in words(value) {
            let concrete = !alias.starts_with('!') && !alias.contains(['*', '?', '%']);
            if concrete && !out.contains(&alias) {
                out.push(alias);
            }
        }
    }
    out
}

/// The hosts of the config file at `path`, with where each leads.
pub fn hosts(path: &Path) -> Vec<SshConfigHost> {
    let Some(text) = read(path) else { return Vec::new() };
    aliases(&text)
        .into_iter()
        .map(|alias| {
            let resolved = russh_config::parse(&text, &alias).unwrap_or_else(|_| russh_config::Config::default(&alias));
            let port = resolved.port();
            let host = resolved.host();
            let target = if port == 22 {
                format!("{}@{host}", resolved.user())
            } else {
                format!("{}@{host}:{port}", resolved.user())
            };
            let proxy_jump = resolved.host_config.proxy_jump.clone().filter(|j| !j.eq_ignore_ascii_case("none"));
            SshConfigHost { config: configuration(&alias), target, proxy_jump }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_directives_as_openssh_writes_them() {
        assert_eq!(split_directive("  HostName\t10.0.0.5 "), Some(("HostName", "10.0.0.5")));
        assert_eq!(split_directive("Port=2222"), Some(("Port", "2222")));
        assert_eq!(split_directive("User = me"), Some(("User", "me")));
        assert_eq!(split_directive("# comment"), None);
        assert_eq!(words(r#"a "b c" d"#), ["a", "b c", "d"]);
        assert!(wildcard("*.conf", "work.conf") && wildcard("h?", "h1") && !wildcard("*.conf", "work.config"));
    }

    #[test]
    fn inlines_includes_and_lists_concrete_hosts() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir(dir.join("config.d")).unwrap();
        std::fs::write(
            dir.join("config"),
            "ServerAliveInterval 30\nInclude config.d/*.conf\n\nHost dev4 dev-pro\n\tHostName 43.128.43.60\n\tUser=root\n\
             Match host *.corp\n  User admin\nHost *.internal !secret gpu-?\n  User ops\n\
             Host bastion\n  HostName bastion.example.com\n  Port 2200\n  User jump\n",
        )
        .unwrap();
        std::fs::write(dir.join("config.d/b.conf"), "Host box\n  HostName 10.0.0.7\n  ProxyJump bastion\n  User me\n")
            .unwrap();
        std::fs::write(dir.join("config.d/a.conf"), "Host orb\n  HostName 127.0.0.1\n  Port 32222\n  User dev\n")
            .unwrap();
        std::fs::write(dir.join("config.d/notes.txt"), "Host ignored\n").unwrap();

        let text = read(&dir.join("config")).unwrap();
        assert!(text.starts_with("Host *\nServerAliveInterval 30\nHost orb\n"), "{text}");
        assert_eq!(aliases(&text), ["orb", "box", "dev4", "dev-pro", "bastion"]);

        let hosts = hosts(&dir.join("config"));
        let summary: Vec<(&str, &str, Option<&str>)> =
            hosts.iter().map(|h| (h.config.host.as_str(), h.target.as_str(), h.proxy_jump.as_deref())).collect();
        assert_eq!(
            summary,
            [
                ("orb", "dev@127.0.0.1:32222", None),
                ("box", "me@10.0.0.7", Some("bastion")),
                ("dev4", "root@43.128.43.60", None),
                ("dev-pro", "root@43.128.43.60", None),
                ("bastion", "jump@bastion.example.com:2200", None),
            ]
        );
        assert_eq!(hosts[1].config.id, "ssh-config:box");
        assert_eq!(hosts[1].config.auth, SshAuth::OpenSsh);
        assert!(super::hosts(&dir.join("missing")).is_empty());
    }
}
