//! SSH agent forwarding against a real host (skipped by default): with an agent in
//! `SSH_AUTH_SOCK` holding a key, `OPENIDEA_AGENT_HOST=<~/.ssh/config alias> cargo test -p ide-ssh
//! --test agent_forward -- --ignored`. With forwarding on, the host lists the local agent's
//! keys. (Off is not checked here: a host with `ForwardAgent yes` in `~/.ssh/config` forwards too.)
use ide_core::remote_settings::SshAuth;
use ide_ssh::{Session, SshFiles, SshTarget};
use tokio::io::AsyncReadExt;

async fn remote_keys(host: &str, forward_agent: bool) -> String {
    let target = SshTarget { host: host.into(), auth: SshAuth::OpenSsh, forward_agent, ..Default::default() };
    let session = Session::connect(&target, None, &SshFiles::default()).await.expect("connect");
    let mut stream = session.exec_stream("ssh-add -l 2>&1").await.expect("exec");
    let mut out = String::new();
    stream.read_to_string(&mut out).await.expect("read");
    out.trim().to_owned()
}

#[tokio::test]
#[ignore = "needs a real SSH host (OPENIDEA_AGENT_HOST) and a local agent"]
async fn the_host_uses_this_machines_agent() {
    let host = std::env::var("OPENIDEA_AGENT_HOST").expect("OPENIDEA_AGENT_HOST");
    let local = std::process::Command::new("ssh-add").arg("-l").output().expect("ssh-add");
    let local = String::from_utf8_lossy(&local.stdout).trim().to_owned();
    assert!(!local.is_empty(), "the local agent holds no key");
    assert_eq!(remote_keys(&host, true).await, local);
}
