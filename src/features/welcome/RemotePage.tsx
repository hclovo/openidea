/**
 * Welcome › Remote Development, after Gateway's SSH page: each SSH host with the
 * projects recently opened on it, and a way to open another folder there (in
 * this window, or a new one from the row's menu).
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { commands, isTauri, type RecentProject } from "@/platform/ipc";
import { parseRemoteLocation, recentRemotes, remoteLocation, type RecentRemote } from "@/platform/remote";
import { Button, EmptyState, Icon, IconButton, Spinner, T, showContextMenu, type MenuItem } from "@/ui";
import { openConnectDialog } from "@/features/remote-dev/model";
import { hostName, useSshHosts, type SshHost } from "@/features/remote-dev/sshConfigs";
import { ProjectBadge, recentMenu } from "./RecentList";
import { openRecent, useRecent } from "./recent";
import styles from "./Welcome.module.css";

const SSH_SETTINGS_PAGE = "tools.sshConfigurations";

function asRecent(r: RecentRemote): RecentProject {
  return { path: remoteLocation(r.sshConfig, r.path), name: r.name, openedAtMs: r.openedAtMs, branch: null };
}

export function RemotePage() {
  const tx = useTx();
  const hosts = useSshHosts();
  // Recent projects reload after an entry is removed: read the remote ones again then.
  useRecent((s) => s.projects);
  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (isTauri()) void commands.sshConnected().then((ids) => setConnected(new Set(ids)));
  }, []);
  const recents = recentRemotes();

  return (
    <div className={styles.projects}>
      <div className={styles.header}>
        <div className={styles.remoteTitle}>
          <span className={styles.remoteHeading}>{tx("SSH Hosts")}</span>
          <span className={styles.remoteSubtitle}>
            {tx("Projects run on the host: the IDE backend is installed there on first use.")}
          </span>
        </div>
        <div className={styles.headerButtons}>
          <Button onClick={() => void executeAction("file.settings", SSH_SETTINGS_PAGE)}>
            <T>New Connection…</T>
          </Button>
          <Button variant="primary" disabled={!hosts.length} onClick={() => openConnectDialog()}>
            <T>Connect to Host…</T>
          </Button>
        </div>
      </div>
      {hosts.length === 0 ? (
        <EmptyState title="No SSH hosts yet">
          <p className={styles.landingText}>
            <T>Add an SSH configuration to work on a project of another machine.</T>
          </p>
          <Button onClick={() => void executeAction("file.settings", SSH_SETTINGS_PAGE)}>
            <T>New Connection…</T>
          </Button>
        </EmptyState>
      ) : (
        <div className={styles.projectList}>
          {hosts.map((h) => (
            <HostSection
              key={h.config.id}
              host={h}
              connected={connected.has(h.config.id)}
              projects={recents.filter((r) => r.sshConfig === h.config.id).map(asRecent)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HostSection({ host, connected, projects }: { host: SshHost; connected: boolean; projects: RecentProject[] }) {
  const tx = useTx();
  const config = host.config;
  const name = hostName(host);
  const menu = (): MenuItem[] => [
    {
      id: "openNew",
      label: "Open Folder in New Window…",
      icon: "folder-open",
      run: () => openConnectDialog({ sshConfig: config.id, target: "new" }),
    },
    {
      id: "edit",
      label: "Edit SSH Configurations…",
      icon: "settings",
      run: () => void executeAction("file.settings", SSH_SETTINGS_PAGE),
    },
  ];
  return (
    <section className={styles.host} aria-label={name}>
      <div className={styles.hostHeader}>
        <Icon name="remote-host" size={16} />
        <span className={styles.hostName}>{name}</span>
        {name !== host.target && <span className={styles.hostLabel}>{host.target}</span>}
        {host.fromSshConfig && (
          <span className={styles.hostSource} title={tx("from ~/.ssh/config")}>
            ~/.ssh/config
          </span>
        )}
        {connected && <span className={styles.hostConnected}>{tx("Connected")}</span>}
        <span className={styles.hostSpacer} />
        <Button size="small" onClick={() => openConnectDialog({ sshConfig: config.id })}>
          <T>Open Folder…</T>
        </Button>
        <IconButton
          icon="more"
          title="Host actions"
          size="small"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showContextMenu({ x: r.left, y: r.bottom + 2 }, menu());
          }}
        />
      </div>
      {projects.length === 0 ? (
        <div className={styles.hostEmpty}>{tx("No projects opened on this host yet")}</div>
      ) : (
        projects.map((p) => <HostProject key={p.path} project={p} />)
      )}
    </section>
  );
}

function HostProject({ project }: { project: RecentProject }) {
  const opening = useRecent((s) => s.opening === project.path);
  const path = parseRemoteLocation(project.path)?.path ?? project.path;
  return (
    <div
      role="button"
      tabIndex={0}
      title={path}
      className={clsx(styles.project, styles.hostProject)}
      onClick={() => void openRecent(project)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void openRecent(project);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, recentMenu(project));
      }}
    >
      <ProjectBadge name={project.name} className={styles.projectBadge} />
      <span className={styles.projectText}>
        <span className={styles.projectName}>{project.name}</span>
        <span className={styles.projectPath}>{path}</span>
      </span>
      {opening ? (
        <Spinner size={14} className={styles.projectSpinner} />
      ) : (
        <IconButton
          icon="more"
          title="Project actions"
          size="small"
          className={styles.projectMore}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            showContextMenu({ x: r.left, y: r.bottom + 2 }, recentMenu(project));
          }}
        />
      )}
    </div>
  );
}
