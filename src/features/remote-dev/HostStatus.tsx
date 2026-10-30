/**
 * Remote window status bar widget ("dev-box  CPU 12%  RAM 48%"), after IDEA's
 * backend control center: its popup shows the host's CPU, memory, disk, load
 * and uptime, the ports forwarded from it, and ways to open another folder there.
 */
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import type { MachineStatus, RemoteSession } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { BarButton, Button, Icon, IconButton, Popup, T } from "@/ui";
import { formatSize, formatUptime } from "@/features/perf/format";
import { startPolling } from "@/features/perf/poll";
import { DETAILS_INTERVAL_MS, STATUS_INTERVAL_MS, reconnect, refreshHostStatus, useHostStatus } from "./hostStatus";
import { formatLoad, percent, remoteAddress, resourceLevel, usedShare } from "./model";
import { openInBrowser, showForwardDialog, showPortsWindow, stopForwarding, usePorts } from "./ports";
import styles from "./RemoteDev.module.css";
import { useSshHosts } from "./sshConfigs";

/** Status bar widget id and its name in the status bar's context menu. */
export const HOST_STATUS_WIDGET = { id: "remote.hostStatus", title: "Remote Host Status" } as const;

export function HostStatusWidget() {
  const session = useRemote((s) => s.session);
  return session ? <HostStatusButton session={session} /> : null;
}

function closePopup() {
  useHostStatus.setState({ popupOpen: false });
}

function HostStatusButton({ session }: { session: RemoteSession }) {
  const tx = useTx();
  // The configuration's name or ~/.ssh/config alias, else the host name alone.
  const host = useSshHosts().find((h) => h.config.id === session.sshConfig);
  const name = host?.config.name.trim() || null;
  const status = useHostStatus((s) => s.status);
  const error = useHostStatus((s) => s.error);
  const open = useHostStatus((s) => s.popupOpen);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      startPolling(() => void refreshHostStatus(), {
        intervalMs: open ? DETAILS_INTERVAL_MS : STATUS_INTERVAL_MS,
      }),
    [open, session.sshConfig, session.root],
  );

  const level = status ? resourceLevel(status) : "normal";
  const memory = status ? usedShare(status.memoryTotal, status.memoryAvailable) : null;
  const tooltip = [
    session.host,
    error ? tx("The host does not respond") : null,
    status && level !== "normal" ? tx(level === "critical" ? "Resources critical" : "Resources low") : null,
    status
      ? [
          `CPU ${percent(status.cpu)}`,
          tx`RAM ${percent(memory)}`,
          tx`Disk ${percent(usedShare(status.diskTotal, status.diskAvailable))}`,
        ].join(" · ")
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <BarButton
        ref={ref}
        className={clsx(styles.hostButton, error ? styles.offline : styles[level])}
        aria-expanded={open}
        aria-label={tx`Remote host: ${session.host}`}
        tooltip={tooltip}
        onClick={() => useHostStatus.setState({ popupOpen: !open })}
      >
        <Icon name="remote-host" size={14} />
        <span className={styles.hostName}>{name || shortHost(session.host)}</span>
        {status && !error && (
          <span className={styles.hostMetrics}>
            {`CPU ${percent(status.cpu)}`} {tx`RAM ${percent(memory)}`}
          </span>
        )}
        {error && <span className={styles.hostMetrics}>{tx("Not responding")}</span>}
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={closePopup}
        aria-label="Remote host status"
      >
        <HostStatusPanel session={session} />
      </Popup>
    </>
  );
}

/** `host` of `user@host:port`. */
function shortHost(label: string): string {
  return label.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
}

function Meter({ label, share, value, title }: { label: string; share: number | null; value: string; title?: string }) {
  const tx = useTx();
  const level = share == null ? "normal" : share >= 0.95 ? "critical" : share >= 0.85 ? "low" : "normal";
  return (
    <div className={styles.meter} title={title}>
      <span className={styles.meterLabel}>{tx(label)}</span>
      <div
        className={styles.meterTrack}
        role="meter"
        aria-label={tx(label)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share == null ? undefined : Math.round(share * 100)}
      >
        <div
          className={clsx(styles.meterFill, styles[level])}
          style={{ width: `${Math.round((share ?? 0) * 100)}%` }}
        />
      </div>
      <span className={styles.meterValue}>{value}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  const tx = useTx();
  return (
    <>
      <span className={styles.infoLabel}>{tx(label)}</span>
      <span className={styles.infoValue}>{value}</span>
    </>
  );
}

function Performance({ s }: { s: MachineStatus }) {
  const used = (total: number, available: number) => `${formatSize(total - available)} / ${formatSize(total)}`;
  return (
    <>
      <div className={styles.meters}>
        <Meter label="CPU" share={s.cpu} value={percent(s.cpu)} />
        <Meter
          label="Memory"
          share={usedShare(s.memoryTotal, s.memoryAvailable)}
          value={used(s.memoryTotal, s.memoryAvailable)}
        />
        {s.swapTotal > 0 && (
          <Meter label="Swap" share={usedShare(s.swapTotal, s.swapFree)} value={used(s.swapTotal, s.swapFree)} />
        )}
        {s.diskTotal > 0 && (
          <Meter
            label="Disk"
            share={usedShare(s.diskTotal, s.diskAvailable)}
            value={used(s.diskTotal, s.diskAvailable)}
            title={s.diskPath}
          />
        )}
      </div>
      <div className={styles.info}>
        <Info label="Load average" value={formatLoad(s.load)} />
        <Info label="Processors" value={String(s.cpus)} />
        <Info label="System" value={[s.os, s.kernel, s.arch].filter(Boolean).join(" · ")} />
        <Info label="Uptime" value={formatUptime(s.uptimeSecs * 1000)} />
        {s.backendMemory != null && <Info label="IDE backend" value={formatSize(s.backendMemory)} />}
      </div>
    </>
  );
}

function ForwardedPorts({ sshConfig }: { sshConfig: string }) {
  const tx = useTx();
  const all = usePorts((s) => s.forwards);
  const forwards = all.filter((f) => f.sshConfig === sshConfig);
  return (
    <div className={styles.panelSection}>
      <div className={styles.panelSectionHeader}>
        <span>{tx("Forwarded Ports")}</span>
        <IconButton icon="plus" size="small" title="Forward Port…" onClick={() => showForwardDialog()} />
        <IconButton
          icon="open-in-tool-window"
          size="small"
          title="Show Ports"
          onClick={() => {
            closePopup();
            showPortsWindow();
          }}
        />
      </div>
      {forwards.length === 0 ? (
        <div className={styles.muted}>{tx("No ports forwarded")}</div>
      ) : (
        <ul className={styles.forwardList}>
          {forwards.slice(0, 6).map((f) => (
            <li key={f.id} className={styles.forwardRow}>
              <span className={styles.mono}>{remoteAddress(f.host, f.port)}</span>
              <Icon name="arrow-right" size={12} className={styles.muted} />
              <button type="button" className={styles.link} onClick={() => openInBrowser(f)}>
                localhost:{f.localPort}
              </button>
              <IconButton icon="close" size="small" title="Stop Forwarding" onClick={() => void stopForwarding(f)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HostStatusPanel({ session }: { session: RemoteSession }) {
  const tx = useTx();
  const status = useHostStatus((s) => s.status);
  const error = useHostStatus((s) => s.error);
  const run = (action: string) => {
    closePopup();
    void executeAction(action);
  };
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Icon name="remote-host" size={16} />
        <span className={styles.panelHost} title={session.root}>
          {session.host}
        </span>
        <span className={clsx(styles.state, error ? styles.stateOffline : styles.stateOnline)}>
          {error ? tx("Not responding") : tx("Connected")}
        </span>
      </div>
      {status?.hostname && <div className={styles.panelSub}>{status.hostname}</div>}
      {error && <div className={styles.error}>{error}</div>}
      {status ? (
        <Performance s={status} />
      ) : (
        !error && <div className={styles.muted}>{tx("Reading the host status…")}</div>
      )}
      <ForwardedPorts sshConfig={session.sshConfig} />
      <div className={styles.panelActions}>
        {error && (
          <Button size="small" variant="primary" onClick={reconnect}>
            <T>Reconnect</T>
          </Button>
        )}
        <Button size="small" onClick={() => run("remote.openFolder")}>
          <T>Open Folder…</T>
        </Button>
        <Button size="small" onClick={() => run("remote.newWindow")}>
          <T>New Window…</T>
        </Button>
        <Button size="small" onClick={() => run("remote.disconnect")}>
          <T>Disconnect</T>
        </Button>
      </div>
    </div>
  );
}
