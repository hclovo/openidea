//! The machine this backend runs on, for Remote Development's host status: CPU,
//! memory, disk, load and uptime, and the TCP ports its processes listen on
//! (offered for forwarding). Linux reads `/proc`; macOS asks `sysctl`,
//! `vm_stat`, `ps` and `lsof`.

use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::IdeResult;
use ide_workspace::memory::{ProcessTable, footprint_bytes};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MachineStatus {
    pub hostname: String,
    /// Distribution or product with its version ("Ubuntu 24.04.1 LTS", "macOS 15.1").
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub cpus: u32,
    /// Busy share of all CPUs since the previous reading (0..1); `None`: unknown.
    pub cpu: Option<f64>,
    /// 1, 5 and 15 minute load averages (empty: unknown).
    pub load: Vec<f64>,
    pub memory_total: u64,
    /// Memory new processes get without swapping.
    pub memory_available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
    /// The folder whose file system `disk_*` describe: the project, else the home folder.
    pub disk_path: String,
    pub disk_total: u64,
    pub disk_available: u64,
    pub uptime_secs: u64,
    /// Memory of this IDE backend and its helpers (language servers…), not of
    /// what runs and terminals started.
    pub backend_memory: Option<u64>,
}

/// A TCP port a process of this user listens on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub port: u16,
    /// The address it is bound to (`127.0.0.1`, `0.0.0.0`, `::`…).
    pub address: String,
    pub pid: Option<u32>,
    /// Process name (`node`).
    pub process: Option<String>,
    /// Its command line, shortened.
    pub command: Option<String>,
    /// Started from a run configuration or a terminal of this backend: an
    /// application the user is working on.
    pub from_ide: bool,
}

pub fn register(d: &mut Dispatcher) {
    d.add("machine_status", |c| async move { status(&c.host, &c.window).await })
        .add("machine_ports", |c| async move { listening_ports(&c.host).await });
}

/// The status of this machine; the disk is the project's (else the home folder's).
pub async fn status(host: &Arc<Host>, window: &str) -> IdeResult<MachineStatus> {
    let root = host.project(window).ok().map(|p| p.root.clone());
    let roots = user_roots(host);
    host.blocking(move || {
        let disk = root.or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("/"));
        Ok(read_status(&disk, std::process::id(), &roots))
    })
    .await
}

/// The ports this user's processes listen on, minus the backend's own helpers
/// (language servers, debug adapters, kernels).
pub async fn listening_ports(host: &Arc<Host>) -> IdeResult<Vec<ListeningPort>> {
    let roots = user_roots(host);
    host.blocking(move || {
        let table = ProcessTable::snapshot();
        let sockets = imp::listening_sockets();
        let parent = |pid: u32| table.get(pid).map(|e| e.ppid);
        Ok(classify(sockets, &roots, std::process::id(), &parent, imp::describe))
    })
    .await
}

/// Runs and terminals: what the user starts from this backend.
fn user_roots(host: &Host) -> HashSet<u32> {
    let runs = host.processes.list().into_iter().filter(|r| r.running).filter_map(|r| r.pid);
    runs.chain(host.terminals.list().into_iter().filter_map(|t| t.pid)).collect()
}

fn read_status(disk: &Path, backend: u32, user_roots: &HashSet<u32>) -> MachineStatus {
    let mut s = imp::status();
    s.arch = std::env::consts::ARCH.to_owned();
    s.cpus = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
    s.hostname = hostname();
    s.cpu = imp::cpu_busy();
    s.load = load_average();
    s.disk_path = disk.to_string_lossy().into_owned();
    if let Some((total, available)) = disk_space(disk) {
        s.disk_total = total;
        s.disk_available = available;
    }
    s.backend_memory = backend_memory(backend, user_roots);
    s
}

/// The memory of `backend` and its descendants, without the trees of `user_roots`.
fn backend_memory(backend: u32, user_roots: &HashSet<u32>) -> Option<u64> {
    let table = ProcessTable::snapshot();
    let users: HashSet<u32> = user_roots.iter().flat_map(|&r| table.tree(r)).collect();
    let total: u64 = table.tree(backend).into_iter().filter(|p| !users.contains(p)).filter_map(footprint_bytes).sum();
    (total > 0).then_some(total)
}

#[cfg(unix)]
fn load_average() -> Vec<f64> {
    let mut load = [0f64; 3];
    // SAFETY: `getloadavg` writes at most 3 values into the buffer.
    let n = unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };
    if n == 3 { load.to_vec() } else { Vec::new() }
}

#[cfg(not(unix))]
fn load_average() -> Vec<f64> {
    Vec::new()
}

#[cfg(unix)]
fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; the name ends at the first NUL.
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(not(unix))]
fn hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// (total, available to this user) bytes of the file system holding `path`.
#[cfg(unix)]
fn disk_space(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` only writes into the zeroed struct it is given.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    let (frsize, blocks, avail) = (st.f_frsize as u64, st.f_blocks as u64, st.f_bavail as u64);
    Some((blocks * frsize, avail * frsize))
}

#[cfg(not(unix))]
fn disk_space(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// `text` shortened to `max` characters.
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn shorten(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_owned(),
    }
}

/// Whether `pid` or one of its ancestors is in `roots`.
fn descends_from(pid: u32, roots: &HashSet<u32>, parent: &dyn Fn(u32) -> Option<u32>) -> bool {
    let mut current = pid;
    for _ in 0..256 {
        if roots.contains(&current) {
            return true;
        }
        match parent(current) {
            Some(p) if p != current && p > 1 => current = p,
            _ => return false,
        }
    }
    false
}

/// A listening socket: (port, bound address, owning process).
type Socket = (u16, String, Option<u32>);

/// The user's applications among `sockets`, not the backend's own helpers; one
/// row per port (a process's IPv4 and IPv6 sockets share it). Those started
/// from the IDE come first.
fn classify(
    sockets: Vec<Socket>,
    roots: &HashSet<u32>,
    backend: u32,
    parent: &dyn Fn(u32) -> Option<u32>,
    describe: impl Fn(u32) -> (Option<String>, Option<String>),
) -> Vec<ListeningPort> {
    let backend = HashSet::from([backend]);
    let mut out: Vec<ListeningPort> = Vec::new();
    for (port, address, pid) in sockets {
        if out.iter().any(|p| p.port == port) {
            continue;
        }
        let from_ide = pid.is_some_and(|p| descends_from(p, roots, parent));
        if !from_ide && pid.is_some_and(|p| descends_from(p, &backend, parent)) {
            continue;
        }
        let (process, command) = pid.map(&describe).unwrap_or_default();
        out.push(ListeningPort { port, address, pid, process, command, from_ide });
    }
    out.sort_by_key(|p| (!p.from_ide, p.port));
    out
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{MachineStatus, Socket, shorten};
    use parking_lot::Mutex;
    use std::collections::{HashMap, HashSet};
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::os::unix::fs::MetadataExt;
    use std::time::{Duration, Instant};

    pub fn status() -> MachineStatus {
        let mut s = MachineStatus::default();
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            let bytes = |key: &str| meminfo_kb(&meminfo, key).map(|kb| kb * 1024);
            s.memory_total = bytes("MemTotal").unwrap_or(0);
            s.memory_available = bytes("MemAvailable").or_else(|| bytes("MemFree")).unwrap_or(0);
            s.swap_total = bytes("SwapTotal").unwrap_or(0);
            s.swap_free = bytes("SwapFree").unwrap_or(0);
        }
        s.uptime_secs = std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|u| u.split_whitespace().next()?.parse::<f64>().ok())
            .map_or(0, |secs| secs as u64);
        s.kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default().trim().to_owned();
        s.os = std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|text| os_release_name(&text))
            .unwrap_or_else(|| "Linux".to_owned());
        s
    }

    fn meminfo_kb(text: &str, key: &str) -> Option<u64> {
        text.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
            .and_then(|v| v.split_whitespace().next()?.parse().ok())
    }

    /// `PRETTY_NAME` of `/etc/os-release` (else `NAME VERSION`).
    pub(super) fn os_release_name(text: &str) -> Option<String> {
        let field = |key: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(key)?.strip_prefix('='))
                .map(|v| v.trim().trim_matches('"').to_owned())
                .filter(|v| !v.is_empty())
        };
        field("PRETTY_NAME")
            .or_else(|| Some(format!("{} {}", field("NAME")?, field("VERSION").unwrap_or_default()).trim().to_owned()))
    }

    /// CPU time counters: (busy, total).
    type CpuTimes = (u64, u64);

    /// The last reading, to measure the next one against.
    static LAST: Mutex<Option<(Instant, CpuTimes)>> = Mutex::new(None);

    /// Busy share of the CPUs since the previous call; a first call (or one
    /// long after the previous) measures over a quarter second.
    pub fn cpu_busy() -> Option<f64> {
        let read = || parse_cpu_times(&std::fs::read_to_string("/proc/stat").ok()?);
        let now = read()?;
        let previous = LAST.lock().filter(|(at, _)| at.elapsed() < Duration::from_secs(60)).map(|(_, t)| t);
        let (before, after) = match previous {
            Some(before) if now.1 > before.1 => (before, now),
            _ => {
                std::thread::sleep(Duration::from_millis(250));
                (now, read()?)
            }
        };
        *LAST.lock() = Some((Instant::now(), after));
        busy_share(before, after)
    }

    pub(super) fn busy_share(before: CpuTimes, after: CpuTimes) -> Option<f64> {
        let total = after.1.checked_sub(before.1).filter(|t| *t > 0)?;
        let busy = after.0.saturating_sub(before.0);
        Some((busy as f64 / total as f64).clamp(0.0, 1.0))
    }

    /// The aggregate `cpu` line of `/proc/stat`: busy is all but idle and iowait.
    pub(super) fn parse_cpu_times(stat: &str) -> Option<CpuTimes> {
        let line = stat.lines().find(|l| l.starts_with("cpu "))?;
        let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|n| n.parse().ok()).collect();
        if v.len() < 4 {
            return None;
        }
        // user nice system idle iowait irq softirq steal (guest time is already in user / nice).
        let total: u64 = v.iter().take(8).sum();
        let idle = v[3] + v.get(4).copied().unwrap_or(0);
        Some((total - idle, total))
    }

    /// The LISTEN sockets of `/proc/net/tcp{,6}`: (port, address, uid, inode).
    pub(super) fn parse_listening(text: &str, v6: bool) -> Vec<(u16, String, u32, u64)> {
        let mut out = Vec::new();
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                continue;
            }
            let Some((addr, port)) = f[1].split_once(':') else { continue };
            let (Ok(port), Ok(uid), Ok(inode)) =
                (u16::from_str_radix(port, 16), f[7].parse::<u32>(), f[9].parse::<u64>())
            else {
                continue;
            };
            let Some(address) = (if v6 { ipv6(addr) } else { ipv4(addr) }) else { continue };
            out.push((port, address, uid, inode));
        }
        out
    }

    /// The kernel prints each 32-bit word of the address in host byte order.
    fn ipv4(hex: &str) -> Option<String> {
        let word = u32::from_str_radix(hex, 16).ok()?;
        Some(Ipv4Addr::from(word.to_ne_bytes()).to_string())
    }

    fn ipv6(hex: &str) -> Option<String> {
        if hex.len() != 32 {
            return None;
        }
        let mut bytes = [0u8; 16];
        for (i, chunk) in bytes.chunks_mut(4).enumerate() {
            let word = u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).ok()?;
            chunk.copy_from_slice(&word.to_ne_bytes());
        }
        let addr = Ipv6Addr::from(bytes);
        Some(addr.to_ipv4_mapped().map_or_else(|| addr.to_string(), |v4| v4.to_string()))
    }

    fn uid() -> u32 {
        // SAFETY: `getuid` cannot fail.
        unsafe { libc::getuid() }
    }

    /// Which process of this user holds each socket inode.
    fn socket_owners(inodes: &HashSet<u64>) -> HashMap<u64, u32> {
        let me = uid();
        let mut owners = HashMap::new();
        let Ok(dir) = std::fs::read_dir("/proc") else { return owners };
        for entry in dir.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            if entry.metadata().map(|m| m.uid()).ok() != Some(me) {
                continue;
            }
            let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else { continue };
                let target = target.to_string_lossy();
                let inode = target.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']'));
                if let Some(inode) = inode.and_then(|i| i.parse::<u64>().ok()).filter(|i| inodes.contains(i)) {
                    owners.insert(inode, pid);
                }
            }
            if owners.len() == inodes.len() {
                break;
            }
        }
        owners
    }

    /// The LISTEN sockets of this user, with their processes.
    pub fn listening_sockets() -> Vec<Socket> {
        let me = uid();
        let mut sockets: Vec<(u16, String, u32, u64)> = Vec::new();
        for (path, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
            if let Ok(text) = std::fs::read_to_string(path) {
                sockets.extend(parse_listening(&text, v6));
            }
        }
        sockets.retain(|s| s.2 == me);
        if sockets.is_empty() {
            return Vec::new();
        }
        let owners = socket_owners(&sockets.iter().map(|s| s.3).collect());
        sockets.into_iter().map(|(port, address, _, inode)| (port, address, owners.get(&inode).copied())).collect()
    }

    /// (name, command line) of `pid`.
    pub fn describe(pid: u32) -> (Option<String>, Option<String>) {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_owned());
        let command = std::fs::read(format!("/proc/{pid}/cmdline")).ok().map(|raw| {
            let parts: Vec<String> = raw
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect();
            shorten(&parts.join(" "), 200)
        });
        (name.filter(|n| !n.is_empty()), command.filter(|c| !c.is_empty()))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{MachineStatus, Socket, shorten};

    fn run(program: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new(program).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn sysctl(name: &str) -> Option<String> {
        run("sysctl", &["-n", name]).map(|s| s.trim().to_owned())
    }

    pub fn status() -> MachineStatus {
        let mut s = MachineStatus {
            memory_total: sysctl("hw.memsize").and_then(|v| v.parse().ok()).unwrap_or(0),
            ..Default::default()
        };
        if let Some(vm) = run("vm_stat", &[]) {
            // "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
            let page = vm
                .lines()
                .next()
                .and_then(|l| l.split("page size of ").nth(1)?.split_whitespace().next()?.parse::<u64>().ok())
                .unwrap_or(4096);
            let pages = |key: &str| {
                vm.lines()
                    .find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
                    .and_then(|v| v.trim().trim_end_matches('.').parse::<u64>().ok())
                    .unwrap_or(0)
            };
            s.memory_available = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page;
        }
        // "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)"
        if let Some(swap) = sysctl("vm.swapusage") {
            let bytes = |key: &str| {
                swap.split(key)
                    .nth(1)
                    .and_then(|v| v.split_whitespace().next())
                    .and_then(|v| v.trim_end_matches('M').parse::<f64>().ok())
                    .map_or(0, |mb| (mb * 1024.0 * 1024.0) as u64)
            };
            s.swap_total = bytes("total = ");
            s.swap_free = bytes("free = ");
        }
        // "{ sec = 1700000000, usec = 0 } Mon Nov 13 …"
        let boot = sysctl("kern.boottime")
            .and_then(|v| v.split("sec = ").nth(1)?.split(',').next()?.trim().parse::<u64>().ok());
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        s.uptime_secs = boot.map_or(0, |b| now.saturating_sub(b));
        s.kernel = run("uname", &["-r"]).unwrap_or_default().trim().to_owned();
        s.os = format!("macOS {}", run("sw_vers", &["-productVersion"]).unwrap_or_default().trim()).trim().to_owned();
        s
    }

    /// The `ps` CPU shares of all processes (each a recent average) over all CPUs.
    pub fn cpu_busy() -> Option<f64> {
        let out = run("ps", &["-A", "-o", "%cpu="])?;
        let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
        let busy: f64 = out.lines().filter_map(|l| l.trim().parse::<f64>().ok()).sum();
        Some((busy / (cpus * 100.0)).clamp(0.0, 1.0))
    }

    /// The LISTEN sockets of this user (`lsof -F`: `p<pid>` then `n<address>:<port>` lines).
    pub fn listening_sockets() -> Vec<Socket> {
        // SAFETY: `getuid` cannot fail.
        let uid = unsafe { libc::getuid() }.to_string();
        let Some(out) = run("lsof", &["-nP", "-a", "-u", uid.as_str(), "-iTCP", "-sTCP:LISTEN", "-Fpn"]) else {
            return Vec::new();
        };
        let mut sockets = Vec::new();
        let mut pid = None;
        for line in out.lines() {
            match line.split_at_checked(1) {
                Some(("p", v)) => pid = v.parse::<u32>().ok(),
                Some(("n", v)) => {
                    let Some((address, port)) = v.rsplit_once(':') else { continue };
                    let Ok(port) = port.parse::<u16>() else { continue };
                    let address = match address.trim_matches(|c| c == '[' || c == ']') {
                        "*" => "0.0.0.0",
                        a => a,
                    };
                    sockets.push((port, address.to_owned(), pid));
                }
                _ => {}
            }
        }
        sockets
    }

    /// (name, command line) of `pid`.
    pub fn describe(pid: u32) -> (Option<String>, Option<String>) {
        let command = run("ps", &["-o", "command=", "-p", &pid.to_string()]).map(|c| shorten(&c, 200));
        let name = command
            .as_deref()
            .and_then(|c| c.split_whitespace().next())
            .map(|p| p.rsplit('/').next().unwrap_or(p).to_owned());
        (name, command.filter(|c| !c.is_empty()))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    use super::{MachineStatus, Socket};

    pub fn status() -> MachineStatus {
        MachineStatus {
            os: std::env::consts::OS.to_owned(),
            memory_total: ide_workspace::process::total_memory_bytes().unwrap_or(0),
            ..Default::default()
        }
    }

    pub fn cpu_busy() -> Option<f64> {
        None
    }

    pub fn listening_sockets() -> Vec<Socket> {
        Vec::new()
    }

    pub fn describe(_pid: u32) -> (Option<String>, Option<String>) {
        (None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn lists_applications_not_the_backend_helpers() {
        // 10: the backend; 20: its language server; 30: a terminal shell; 31: `npm run dev` in it.
        let parents = HashMap::from([(20, 10), (30, 10), (31, 30), (40, 7)]);
        let roots = HashSet::from([30]);
        let sockets = vec![
            (5173, "127.0.0.1".to_owned(), Some(31)),
            (5173, "::1".to_owned(), Some(31)),
            (41234, "127.0.0.1".to_owned(), Some(20)),
            (8888, "0.0.0.0".to_owned(), Some(40)),
            (22, "0.0.0.0".to_owned(), None),
        ];
        let parent = |pid: u32| parents.get(&pid).copied();
        let ports = classify(sockets, &roots, 10, &parent, |pid| (Some(format!("p{pid}")), None));
        let rows: Vec<(u16, bool, Option<&str>)> =
            ports.iter().map(|p| (p.port, p.from_ide, p.process.as_deref())).collect();
        assert_eq!(rows, [(5173, true, Some("p31")), (22, false, None), (8888, false, Some("p40"))]);
        assert_eq!(shorten("  node  server.js ", 4), "node…");
        assert_eq!(shorten("node", 4), "node");
    }

    #[cfg(all(target_os = "linux", target_endian = "little"))]
    #[test]
    fn parses_proc_files() {
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0\n\
           1: 0100007F:1436 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 4243 1 0\n\
           2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 17 1 0\n";
        assert_eq!(
            imp::parse_listening(tcp, false),
            [(5173, "127.0.0.1".into(), 1000, 4242), (22, "0.0.0.0".into(), 0, 17)]
        );
        let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99 1 0\n\
           1: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 98 1 0\n";
        assert_eq!(
            imp::parse_listening(tcp6, true),
            [(8080, "::1".into(), 1000, 99), (80, "127.0.0.1".into(), 1000, 98)]
        );

        assert_eq!(imp::parse_cpu_times("cpu  10 0 5 80 5 0 0 0 0 0\ncpu0 1 2 3 4\n"), Some((15, 100)));
        assert_eq!(imp::busy_share((100, 1000), (150, 1100)), Some(0.5));
        assert_eq!(imp::busy_share((100, 1000), (100, 1000)), None);
        let release = "NAME=\"Ubuntu\"\nVERSION=\"24.04.1 LTS (Noble Numbat)\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
        assert_eq!(imp::os_release_name(release).as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(imp::os_release_name("NAME=Arch\nVERSION=rolling\n").as_deref(), Some("Arch rolling"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_this_machine() {
        let s = read_status(Path::new("/"), std::process::id(), &HashSet::new());
        assert!(s.memory_total > 0 && s.memory_available <= s.memory_total, "{s:?}");
        assert!(s.disk_total > 0 && s.disk_available <= s.disk_total, "{s:?}");
        assert!(s.cpus > 0 && s.uptime_secs > 0 && !s.kernel.is_empty() && !s.hostname.is_empty(), "{s:?}");
        assert!(s.cpu.is_some_and(|c| (0.0..=1.0).contains(&c)), "{s:?}");
        assert_eq!(s.load.len(), 3);
        assert!(s.backend_memory.is_some_and(|m| m > 0), "{s:?}");

        // A port this test listens on is found with its process; it is the
        // user's own unless the backend started it outside a run or terminal.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        let mine = imp::listening_sockets().into_iter().find(|s| s.0 == port).expect("own listening port");
        assert_eq!((mine.1.as_str(), mine.2), ("127.0.0.1", Some(me)));
        let no_parent = |_| None;
        let ports = classify(vec![mine.clone()], &HashSet::new(), 0, &no_parent, imp::describe);
        assert_eq!((ports[0].from_ide, ports[0].process.is_some()), (false, true));
        assert!(classify(vec![mine.clone()], &HashSet::new(), me, &no_parent, imp::describe).is_empty());
        let ports = classify(vec![mine], &HashSet::from([me]), me, &no_parent, imp::describe);
        assert!(ports[0].from_ide);
    }
}
