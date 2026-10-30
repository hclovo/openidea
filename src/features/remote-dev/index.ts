/**
 * Remote development: a window whose project lives on an SSH host. The backend
 * (`openidea-server`) runs there and this window routes its commands to it
 * (platform/remote.ts). Around it, after IDEA's Gateway and backend control
 * center: the host's status in the status bar, port forwarding (the Ports tool
 * window) and opening more folders of the host, here or in new windows.
 */
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RemoteSession } from "@/platform/ipc";
import { disconnectRemote, provideSshRetry, useRemote } from "@/platform/remote";
import { lazyComponent } from "@/ui";
import { maybeEditorService, registerOverlay, registerStatusItem, registerToolWindow } from "@/workbench/contributions";
import { confirmLeaveProject } from "@/platform/project";
import { withSsh } from "@/features/deployment/ssh";
import { startPolling } from "@/features/perf/poll";
import { ConnectHost } from "./ConnectDialog";
import { reloadEnvironment } from "./environment";
import { ForwardPortHost } from "./ForwardPortDialog";
import { HOST_STATUS_WIDGET, HostStatusWidget } from "./HostStatus";
import { resetHostStatus, useHostStatus } from "./hostStatus";
import { closeConnectDialog, openConnectDialog } from "./model";
import {
  PORTS_WINDOW,
  checkListeningPorts,
  closeForwardDialog,
  refreshForwards,
  resetPortWatch,
  restoreForwards,
  showForwardDialog,
  showPortsWindow,
} from "./ports";

/** How often a remote window looks for new listening ports on its host. */
const PORT_WATCH_MS = 5000;

/** Follows this window's remote session: context key, host status, forwarded and listening ports. */
function followSession(): () => void {
  let stopWatch: (() => void) | null = null;
  let current: RemoteSession | null = null;
  const apply = (session: RemoteSession | null) => {
    if (session === current) return;
    const sameHost = !!session && !!current && session.sshConfig === current.sshConfig;
    current = session;
    setContext("remoteWindow", !!session);
    stopWatch?.();
    stopWatch = null;
    if (!sameHost) resetHostStatus();
    resetPortWatch();
    if (!session) {
      void refreshForwards();
      return;
    }
    void restoreForwards(session);
    stopWatch = startPolling(() => void checkListeningPorts(), { intervalMs: PORT_WATCH_MS });
  };
  apply(useRemote.getState().session);
  const unsubscribe = useRemote.subscribe((s) => apply(s.session));
  return () => {
    unsubscribe();
    stopWatch?.();
    setContext("remoteWindow", false);
  };
}

export function activate(): () => void {
  const disposers = [
    provideSshRetry(withSsh),
    followSession(),
    registerOverlay({ id: "remote.connect", component: ConnectHost }),
    registerOverlay({ id: "remote.forwardPort", component: ForwardPortHost }),
    registerToolWindow({
      id: PORTS_WINDOW,
      title: "Ports",
      icon: "toolwindow-ports",
      anchor: "bottom",
      order: 60,
      stripe: "onUse",
      component: lazyComponent(() => import("./PortsView").then((m) => m.PortsView)),
    }),
    registerStatusItem({ ...HOST_STATUS_WIDGET, align: "right", priority: 40, component: HostStatusWidget }),
    registerActions([
      {
        id: "remote.connect",
        title: "Remote Development…",
        description: "Opens a project folder on an SSH host; the IDE backend runs on that host.",
        category: "File",
        icon: "remote-host",
        keywords: ["ssh", "remote", "server", "gateway", "connect", "host"],
        run: () => openConnectDialog(),
      },
      {
        id: "remote.openFolder",
        title: "Open Folder on Remote Host…",
        description: "Opens another folder of this window's SSH host, in this or a new window.",
        category: "File",
        icon: "folder-open",
        keywords: ["ssh", "remote", "open", "folder", "project", "switch"],
        when: "remoteWindow",
        run: () => openConnectDialog({ sshConfig: useRemote.getState().session?.sshConfig }),
      },
      {
        id: "remote.newWindow",
        title: "New Window on Remote Host…",
        description: "Opens a folder of an SSH host in a new window (a new remote workspace).",
        category: "Window",
        icon: "remote-host",
        keywords: ["ssh", "remote", "window", "workspace", "new", "connect"],
        run: () => openConnectDialog({ sshConfig: useRemote.getState().session?.sshConfig, target: "new" }),
      },
      {
        id: "remote.disconnect",
        title: "Disconnect from Remote Host",
        category: "File",
        keywords: ["ssh", "remote", "close"],
        when: "remoteWindow",
        run: async () => {
          if (!(await confirmLeaveProject())) return;
          try {
            await disconnectRemote();
          } catch (e) {
            maybeEditorService()?.cancelClose?.();
            throw e;
          }
        },
      },
      {
        id: "remote.reloadEnvironment",
        title: "Reload Environment",
        description:
          "Reads the login shell's environment (and devcontainer.json remoteEnv on a remote host) again for new terminals and processes.",
        category: "File",
        keywords: ["env", "environment", "variables", "path", "shell", "remoteEnv", "devcontainer", "reload"],
        when: "projectOpen",
        run: () => reloadEnvironment(),
      },
      {
        id: "remote.forwardPort",
        title: "Forward Port…",
        description: "Makes a port of an SSH host reachable at localhost on this machine (like ssh -L).",
        category: "Tools",
        icon: "toolwindow-ports",
        keywords: ["ssh", "remote", "port", "forward", "tunnel", "localhost"],
        when: "projectOpen",
        run: ({ arg }) => showForwardDialog(typeof arg === "number" ? { port: arg } : {}),
      },
      {
        id: "remote.showPorts",
        title: "Ports",
        description: "Shows the forwarded ports and the ports listening on the remote host.",
        category: "View",
        icon: "toolwindow-ports",
        keywords: ["ssh", "remote", "port", "forward", "tunnel"],
        when: "projectOpen",
        run: () => showPortsWindow(),
      },
      {
        id: "remote.hostStatus",
        title: "Remote Host Status",
        description: "CPU, memory, disk and load of the remote host, and the ports forwarded from it.",
        category: "View",
        icon: "remote-host",
        keywords: ["ssh", "remote", "cpu", "memory", "disk", "load", "metrics", "status", "machine"],
        when: "remoteWindow",
        run: () => useHostStatus.setState({ popupOpen: true }),
      },
    ]),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    closeConnectDialog();
    closeForwardDialog();
  };
}
