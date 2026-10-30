/**
 * Ports tool window: the ports this window forwards from SSH hosts and, in a
 * remote window, the ports its host's processes listen on (forward with a click).
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useTx, useTxTemplate } from "@/platform/i18n";
import type { ListeningPort, PortForward } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { Button, EmptyState, IconButton, T, showContextMenu, type MenuItem } from "@/ui";
import { isOwnHost, remoteAddress } from "./model";
import {
  changeLocalPort,
  copyLocalAddress,
  forwardPort,
  localUrl,
  openInBrowser,
  refreshForwards,
  showForwardDialog,
  stopForwarding,
  usePorts,
} from "./ports";
import styles from "./RemoteDev.module.css";
import { hostName, useSshHosts } from "./sshConfigs";

const REFRESH_MS = 3000;

function forwardMenu(f: PortForward): MenuItem[] {
  return [
    { id: "open", label: "Open in Browser", icon: "web", run: () => openInBrowser(f) },
    { id: "copy", label: "Copy Local Address", icon: "copy", run: () => copyLocalAddress(f) },
    { id: "change", label: "Change Forwarded Port…", run: () => void changeLocalPort(f) },
    { kind: "separator" },
    { id: "stop", label: "Stop Forwarding", icon: "stop", run: () => void stopForwarding(f) },
  ];
}

export function PortsView() {
  const tx = useTx();
  const txt = useTxTemplate();
  const forwards = usePorts((s) => s.forwards);
  const listening = usePorts((s) => s.listening);
  const session = useRemote((s) => s.session);
  const hosts = useSshHosts();
  const [selected, setSelected] = useState<number | null>(null);

  // Connection counts and errors change as the forwards are used.
  useEffect(() => {
    void refreshForwards();
    const timer = setInterval(() => void refreshForwards(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const hostOf = (sshConfig: string) => {
    const host = hosts.find((h) => h.config.id === sshConfig);
    return host ? hostName(host) : sshConfig;
  };
  const processOn = (f: PortForward) =>
    session && f.sshConfig === session.sshConfig && isOwnHost(f.host)
      ? listening.find((p) => p.port === f.port)
      : undefined;
  const forwardedHere = new Set(
    forwards.filter((f) => session && f.sshConfig === session.sshConfig && isOwnHost(f.host)).map((f) => f.port),
  );
  const offered = session ? listening.filter((p) => !forwardedHere.has(p.port)) : [];
  const current = forwards.find((f) => f.id === selected) ?? null;

  return (
    <div className={styles.ports}>
      <div className={styles.portsToolbar} role="toolbar" aria-label={tx("Ports actions")}>
        <IconButton icon="plus" title="Forward Port…" onClick={() => showForwardDialog()} />
        <IconButton
          icon="stop"
          title="Stop Forwarding"
          disabled={!current}
          onClick={() => current && void stopForwarding(current)}
        />
        <IconButton
          icon="web"
          title="Open in Browser"
          disabled={!current}
          onClick={() => current && openInBrowser(current)}
        />
        <IconButton icon="refresh" title="Refresh" onClick={() => void refreshForwards()} />
      </div>
      {forwards.length === 0 && offered.length === 0 ? (
        <EmptyState title="No ports forwarded">
          <p className={styles.portsHint}>
            <T>Forward a port to reach a service of an SSH host, such as a web server, at localhost on this machine.</T>
          </p>
          <Button onClick={() => showForwardDialog()}>
            <T>Forward a Port…</T>
          </Button>
        </EmptyState>
      ) : (
        <div className={styles.portsScroll}>
          <table className={styles.portsTable} aria-label={tx("Forwarded ports")}>
            <thead>
              <tr>
                <th>{tx("Port")}</th>
                <th>{tx("Forwarded Address")}</th>
                <th>{tx("Host")}</th>
                <th>{tx("Running Process")}</th>
                <th>{tx("Status")}</th>
                <th aria-label={tx("Actions")} />
              </tr>
            </thead>
            <tbody>
              {forwards.map((f) => {
                const process = processOn(f);
                return (
                  <tr
                    key={f.id}
                    aria-selected={f.id === selected}
                    className={clsx(f.id === selected && styles.selectedRow)}
                    onClick={() => setSelected(f.id)}
                    onDoubleClick={() => openInBrowser(f)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(f.id);
                      showContextMenu(e, forwardMenu(f));
                    }}
                  >
                    <td className={styles.mono}>
                      {remoteAddress(f.host, f.port)}
                      {f.label && <span className={styles.portLabel}>{f.label}</span>}
                    </td>
                    <td>
                      <a
                        className={styles.link}
                        href={localUrl(f)}
                        onClick={(e) => {
                          e.preventDefault();
                          openInBrowser(f);
                        }}
                      >
                        localhost:{f.localPort}
                      </a>
                    </td>
                    <td>{hostOf(f.sshConfig)}</td>
                    <td className={styles.process} title={process?.command ?? undefined}>
                      {process?.process ?? ""}
                    </td>
                    <td className={clsx(f.error && styles.portError)} title={f.error ? txt(f.error) : undefined}>
                      <ForwardStatus f={f} />
                    </td>
                    <td className={styles.rowActions}>
                      <IconButton icon="web" size="small" title="Open in Browser" onClick={() => openInBrowser(f)} />
                      <IconButton
                        icon="close"
                        size="small"
                        title="Stop Forwarding"
                        onClick={() => void stopForwarding(f)}
                      />
                    </td>
                  </tr>
                );
              })}
              {offered.length > 0 && (
                <tr className={styles.sectionRow}>
                  <td colSpan={6}>{session ? tx`Listening on ${session.host}` : null}</td>
                </tr>
              )}
              {offered.map((p) => (
                <DetectedRow
                  key={`l${p.port}`}
                  p={p}
                  sshConfig={session?.sshConfig ?? ""}
                  host={session ? hostOf(session.sshConfig) : ""}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ForwardStatus({ f }: { f: PortForward }) {
  const tx = useTx();
  if (f.error) return <>{tx("Not reachable")}</>;
  if (f.active > 0) return <>{f.active === 1 ? tx("1 connection") : tx`${f.active} connections`}</>;
  return <>{tx("Forwarded")}</>;
}

function DetectedRow({ p, sshConfig, host }: { p: ListeningPort; sshConfig: string; host: string }) {
  const tx = useTx();
  const request = { sshConfig, port: p.port, host: "localhost", localPort: null, label: "" };
  return (
    <tr className={styles.detectedRow}>
      <td className={styles.mono}>{remoteAddress("localhost", p.port)}</td>
      <td className={styles.muted}>{tx("Not forwarded")}</td>
      <td>{host}</td>
      <td className={styles.process} title={p.command ?? undefined}>
        {p.process ?? ""}
      </td>
      <td className={styles.muted}>{p.fromIde ? tx("Started from the IDE") : tx("Listening")}</td>
      <td className={styles.rowActions}>
        <Button size="small" onClick={() => void forwardPort(request)}>
          <T>Forward Port</T>
        </Button>
      </td>
    </tr>
  );
}
