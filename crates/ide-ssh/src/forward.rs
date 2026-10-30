//! Port forwarding (the Ports tool window, like `ssh -L`): a local port whose
//! connections reach a port as the SSH host sees it. Each forward listens on
//! 127.0.0.1 and opens a `direct-tcpip` channel per connection through the
//! shared session of its SSH configuration, which reconnects if it dropped.
//! Forwards belong to the window that asked for them.

use crate::manager::SshManager;
use crate::target::{SshTarget, resolve_hops};
use crate::tunnel::unreachable_target;
use ide_core::{IdeError, IdeResult, error::ErrorKind};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

/// What to forward.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest {
    pub ssh_config: String,
    /// The port as the SSH host reaches it.
    pub port: u16,
    /// The host the SSH host connects to; empty: `localhost` (the SSH host itself).
    #[serde(default)]
    pub host: String,
    /// The local port; `None`: the same as `port` when it is free, else any free one.
    #[serde(default)]
    pub local_port: Option<u16>,
    #[serde(default)]
    pub label: String,
}

/// A forwarded port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: u32,
    pub ssh_config: String,
    /// The host the SSH host connects to (`localhost`: itself).
    pub host: String,
    pub port: u16,
    /// Where it is reached on this machine: `localhost:<local_port>`.
    pub local_port: u16,
    pub label: String,
    /// Connections being forwarded right now.
    pub active: u32,
    /// Connections forwarded so far.
    pub total: u32,
    /// Why the last connection could not reach the port (nothing listening…);
    /// cleared by the next one that does.
    pub error: Option<String>,
}

struct Entry {
    owner: String,
    info: Arc<Mutex<PortForward>>,
    accept: JoinHandle<()>,
}

impl Drop for Entry {
    /// Stops listening and closes the connections it forwards.
    fn drop(&mut self) {
        self.accept.abort();
    }
}

/// The forwarded ports of every window.
pub struct PortForwards {
    ssh: Arc<SshManager>,
    next: AtomicU32,
    entries: Mutex<BTreeMap<u32, Entry>>,
}

impl PortForwards {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        Self { ssh, next: AtomicU32::new(1), entries: Mutex::default() }
    }

    /// Forwards `request.port` for window `owner`. Connects first, so an unknown
    /// host key or a missing password is reported before a local port is taken.
    pub async fn forward(&self, owner: &str, request: ForwardRequest) -> IdeResult<PortForward> {
        let host = target_host(&request.host);
        check_port(request.port)?;
        if let Some(local) = request.local_port {
            check_port(local)?;
        }
        duplicate(&self.entries.lock(), owner, &request.ssh_config, &host, request.port)?;
        self.ssh.session(&request.ssh_config).await?;
        // The SSH host is this machine: the same local port would forward to itself.
        let cyclic = self.loops_back(&request.ssh_config, &host);
        if cyclic && request.local_port == Some(request.port) {
            return Err(cyclic_error(request.port));
        }
        let listener = bind(request.local_port, (!cyclic).then_some(request.port)).await?;
        let info = PortForward {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            ssh_config: request.ssh_config,
            host,
            port: request.port,
            local_port: listener.local_addr()?.port(),
            label: request.label.trim().to_owned(),
            active: 0,
            total: 0,
            error: None,
        };
        let snapshot = info.clone();
        let info = Arc::new(Mutex::new(info));
        let accept = tokio::spawn(accept_loop(listener, self.ssh.clone(), info.clone()));
        let entry = Entry { owner: owner.to_owned(), info, accept };
        let mut entries = self.entries.lock();
        // Another request for the same port may have finished while this one connected.
        duplicate(&entries, owner, &snapshot.ssh_config, &snapshot.host, snapshot.port)?;
        entries.insert(snapshot.id, entry);
        Ok(snapshot)
    }

    /// Whether `host` as seen from the SSH host of `ssh_config` is this machine:
    /// the SSH host is reached directly at a loopback address, and so is `host` from there.
    fn loops_back(&self, ssh_config: &str, host: &str) -> bool {
        let Ok(config) = self.ssh.config(ssh_config) else { return false };
        let hops = resolve_hops(&SshTarget::from(&config), self.ssh.files().config.as_deref());
        is_loopback(host) && hops.is_ok_and(|hops| hops.len() == 1 && is_loopback(&hops[0].host))
    }

    /// The forwards of window `owner`, oldest first.
    pub fn list(&self, owner: &str) -> Vec<PortForward> {
        self.entries.lock().values().filter(|e| e.owner == owner).map(|e| e.info.lock().clone()).collect()
    }

    /// Stops forward `id` of `owner`; `false` when there is none.
    pub fn stop(&self, owner: &str, id: u32) -> bool {
        let mut entries = self.entries.lock();
        if !entries.get(&id).is_some_and(|e| e.owner == owner) {
            return false;
        }
        entries.remove(&id);
        true
    }

    /// Stops the forwards of `owner` (its window closed).
    pub fn stop_owner(&self, owner: &str) {
        let gone: Vec<Entry> = {
            let mut entries = self.entries.lock();
            let ids: Vec<u32> = entries.iter().filter(|(_, e)| e.owner == owner).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| entries.remove(&id)).collect()
        };
        drop(gone);
    }

    /// Stops the forwards of `owner` through SSH configuration `ssh_config` (it left that host).
    pub fn stop_config(&self, owner: &str, ssh_config: &str) {
        let gone: Vec<Entry> = {
            let mut entries = self.entries.lock();
            let ids: Vec<u32> = entries
                .iter()
                .filter(|(_, e)| e.owner == owner && e.info.lock().ssh_config == ssh_config)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| entries.remove(&id)).collect()
        };
        drop(gone);
    }

    /// Moves forward `id` to another local port (`None`: any free one); its
    /// open connections close.
    pub async fn change_local_port(&self, owner: &str, id: u32, local_port: Option<u16>) -> IdeResult<PortForward> {
        if let Some(p) = local_port {
            check_port(p)?;
        }
        let info = {
            let entries = self.entries.lock();
            let entry = entries.get(&id).filter(|e| e.owner == owner);
            entry.map(|e| e.info.clone()).ok_or_else(|| IdeError::not_found(format!("no forwarded port {id}")))?
        };
        let (current, port, config, host) = {
            let i = info.lock();
            (i.local_port, i.port, i.ssh_config.clone(), i.host.clone())
        };
        if local_port == Some(current) {
            return Ok(info.lock().clone());
        }
        if local_port == Some(port) && self.loops_back(&config, &host) {
            return Err(cyclic_error(port));
        }
        let listener = bind(local_port, None).await?;
        let mut entries = self.entries.lock();
        let entry = entries
            .get_mut(&id)
            .filter(|e| Arc::ptr_eq(&e.info, &info))
            .ok_or_else(|| IdeError::not_found(format!("no forwarded port {id}")))?;
        {
            let mut i = info.lock();
            i.local_port = listener.local_addr()?.port();
            i.active = 0;
            i.error = None;
        }
        entry.accept.abort();
        entry.accept = tokio::spawn(accept_loop(listener, self.ssh.clone(), info.clone()));
        Ok(info.lock().clone())
    }
}

/// Fails when `owner` already forwards `port` of `host` through `ssh_config`.
fn duplicate(entries: &BTreeMap<u32, Entry>, owner: &str, ssh_config: &str, host: &str, port: u16) -> IdeResult<()> {
    for entry in entries.values().filter(|e| e.owner == owner) {
        let i = entry.info.lock();
        if i.ssh_config == ssh_config && i.port == port && i.host.eq_ignore_ascii_case(host) {
            return Err(IdeError::invalid(format!("Port {port} is already forwarded to localhost:{}", i.local_port)));
        }
    }
    Ok(())
}

/// `localhost` for an empty host.
fn target_host(host: &str) -> String {
    let host = host.trim();
    if host.is_empty() { "localhost".to_owned() } else { host.to_owned() }
}

fn check_port(port: u16) -> IdeResult<()> {
    if port == 0 {
        return Err(IdeError::invalid("The port number should be between 1 and 65535"));
    }
    Ok(())
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

fn cyclic_error(port: u16) -> IdeError {
    IdeError::invalid(format!("Forwarding port {port} to itself would loop: the SSH host is this machine"))
}

/// A listener on `local`, else on `preferred` when free, else on any free port.
async fn bind(local: Option<u16>, preferred: Option<u16>) -> IdeResult<TcpListener> {
    match local {
        Some(port) => TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => IdeError::invalid(format!("Local port {port} is already in use")),
            std::io::ErrorKind::PermissionDenied => IdeError::new(
                ErrorKind::PermissionDenied,
                format!("Local port {port} needs administrator rights; choose one above 1023"),
            ),
            _ => IdeError::from(e),
        }),
        None => match preferred {
            Some(port) => match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
                Ok(listener) => Ok(listener),
                Err(_) => Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?),
            },
            None => Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?),
        },
    }
}

/// Accepts connections until aborted; aborting also closes the open ones.
async fn accept_loop(listener: TcpListener, ssh: Arc<SshManager>, info: Arc<Mutex<PortForward>>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    connections.spawn(forward_one(socket, ssh.clone(), info.clone()));
                }
                Err(e) => {
                    // Out of file descriptors and the like: try again shortly.
                    tracing::warn!("port forwarding: accept failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// Counts a connection as active while it lives.
struct Active(Arc<Mutex<PortForward>>);

impl Drop for Active {
    fn drop(&mut self) {
        let mut i = self.0.lock();
        i.active = i.active.saturating_sub(1);
    }
}

async fn forward_one(mut socket: TcpStream, ssh: Arc<SshManager>, info: Arc<Mutex<PortForward>>) {
    let (config, host, port) = {
        let i = info.lock();
        (i.ssh_config.clone(), i.host.clone(), i.port)
    };
    let channel = match ssh.session(&config).await {
        Ok(session) => session
            .direct_tcpip(&host, port)
            .await
            .map_err(|e| unreachable_target(session.label(), &host, port, &e).message),
        Err(e) => Err(e.message),
    };
    match channel {
        Ok(mut stream) => {
            let _active = {
                let mut i = info.lock();
                i.active += 1;
                i.total = i.total.saturating_add(1);
                i.error = None;
                Active(info.clone())
            };
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
        }
        Err(message) => {
            tracing::debug!("port forwarding: {message}");
            info.lock().error = Some(message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_host_is_the_ssh_host_itself() {
        assert_eq!(target_host(" "), "localhost");
        assert_eq!(target_host(" db.internal "), "db.internal");
        assert!(check_port(0).is_err());
        assert!(check_port(8080).is_ok());
        assert!(is_loopback("LOCALHOST") && is_loopback("127.0.0.2") && is_loopback("::1") && is_loopback("0.0.0.0"));
        assert!(!is_loopback("db.internal") && !is_loopback("10.0.0.5"));
    }

    #[tokio::test]
    async fn takes_the_same_port_when_free_else_any() {
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = taken.local_addr().unwrap().port();
        let other = bind(None, Some(port)).await.unwrap();
        assert_ne!(other.local_addr().unwrap().port(), port);
        let e = bind(Some(port), None).await.unwrap_err();
        assert_eq!(e.message, format!("Local port {port} is already in use"));
        drop(taken);
        let same = bind(None, Some(port)).await.unwrap();
        assert_eq!(same.local_addr().unwrap().port(), port);
        assert!(bind(None, None).await.is_ok());
    }
}
