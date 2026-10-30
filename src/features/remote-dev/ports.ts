/**
 * Port forwarding (the Ports tool window, after IDEA's backend control center
 * and VS Code's Ports view): ports of an SSH host made reachable on this
 * machine. The forwards run in Rust (`ide_ssh::forward`) and belong to this
 * window. In a remote window they are remembered per project and forwarded
 * again when it is opened, and the ports that applications started from the
 * IDE begin to listen on are offered for forwarding.
 */
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import {
  call,
  commands,
  isTauri,
  type ForwardRequest,
  type ListeningPort,
  type PortForward,
  type RemoteSession,
} from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { remoteLocation, useRemote, withSshRetry } from "@/platform/remote";
import { workflowSettings } from "@/platform/workflowSettings";
import { copyText } from "@/ui";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { promptInput } from "@/workbench/inputDialogs";
import { isOwnHost, newAppPorts, parsePort, remoteAddress, savedForwards, type SavedForward } from "./model";

export const PORTS_WINDOW = "ports";

/** The Forward Port dialog's starting values. */
export interface ForwardDraft {
  sshConfig: string;
  port: number | null;
  host: string;
  localPort: number | null;
  label: string;
  openInBrowser: boolean;
}

interface PortsState {
  forwards: PortForward[];
  /** Ports the processes of this window's remote host listen on. */
  listening: ListeningPort[];
  /** The Forward Port dialog, when open. */
  draft: ForwardDraft | null;
}

export const usePorts = create<PortsState>(() => ({ forwards: [], listening: [], draft: null }));

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function refreshForwards() {
  if (!isTauri()) return;
  const forwards = await commands.portsList().catch(() => null);
  if (forwards) usePorts.setState({ forwards });
}

/** The SSH configuration new forwards go through: this window's host, else the first configured. */
export function defaultSshConfig(): string {
  return useRemote.getState().session?.sshConfig ?? workflowSettings().ssh.configs[0]?.id ?? "";
}

/** Opens the Forward Port dialog (`port`: prefilled, e.g. a detected port). */
export function showForwardDialog(draft: Partial<ForwardDraft> = {}) {
  usePorts.setState({
    draft: {
      sshConfig: defaultSshConfig(),
      port: null,
      host: "localhost",
      localPort: null,
      label: "",
      openInBrowser: false,
      ...draft,
    },
  });
}

export function closeForwardDialog() {
  usePorts.setState({ draft: null });
}

export function localUrl(f: Pick<PortForward, "localPort">): string {
  return `http://localhost:${f.localPort}`;
}

export function openInBrowser(f: Pick<PortForward, "localPort">) {
  void openExternalUrl(localUrl(f));
}

export function copyLocalAddress(f: Pick<PortForward, "localPort">) {
  void copyText(`localhost:${f.localPort}`);
}

export function showPortsWindow() {
  toolWindowService().show(PORTS_WINDOW, true);
}

/**
 * Forwards a port; `throws` lets a dialog show the error itself, otherwise it
 * is a notification. `quiet`: no notification on success.
 */
export async function forwardPort(
  request: ForwardRequest,
  options: { open?: boolean; quiet?: boolean; throws?: boolean } = {},
): Promise<PortForward | null> {
  try {
    const forward = await withSshRetry(request.sshConfig, () => call(commands.portsForward(request)));
    await refreshForwards();
    rememberForwards();
    if (options.open) openInBrowser(forward);
    else if (!options.quiet) notifyForwarded(forward);
    return forward;
  } catch (e) {
    if (options.throws) throw e;
    notifications().notify({
      level: "error",
      title: tx`Cannot forward port ${request.port}`,
      body: errorText(e),
      group: "tools",
      key: `ports.forward:${request.port}`,
    });
    return null;
  }
}

function notifyForwarded(f: PortForward) {
  notifications().notify({
    level: "info",
    title: tx`Port ${f.port} forwarded`,
    body: tx`${remoteAddress(f.host, f.port)} on the remote host can now be accessed through localhost:${f.localPort}.`,
    group: "tools",
    key: `ports.forwarded:${f.id}`,
    actions: [
      { label: "Open in Browser", run: () => openInBrowser(f) },
      { label: "Copy Local Address", run: () => copyLocalAddress(f) },
    ],
  });
}

export async function stopForwarding(f: PortForward) {
  await commands.portsStop(f.id);
  await refreshForwards();
  rememberForwards();
}

/** Change Forwarded Port…: asks for another local port. */
export async function changeLocalPort(f: PortForward) {
  const text = await promptInput({
    title: "Change Forwarded Port",
    label: "Local port:",
    initial: String(f.localPort),
    validate: (v) => (parsePort(v) ? null : "The port number should be between 1 and 65535"),
  });
  const port = text == null ? null : parsePort(text);
  if (port == null || port === f.localPort) return;
  try {
    await call(commands.portsChangeLocal(f.id, port));
  } catch (e) {
    notifications().notify({
      level: "error",
      title: tx`Cannot change the local port of ${f.port}`,
      body: errorText(e),
      group: "tools",
    });
  }
  await refreshForwards();
  rememberForwards();
}

// ---------------------------------------------------------------------------
// Remembered per remote project: `openidea.remote.ports` → location → forwards.

const SAVED_KEY = "openidea.remote.ports";

function savedAll(): Record<string, SavedForward[]> {
  try {
    const all = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}") as unknown;
    return all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, SavedForward[]>) : {};
  } catch {
    return {};
  }
}

export function savedFor(location: string): SavedForward[] {
  const list = savedAll()[location];
  return Array.isArray(list) ? list.filter((f) => f && parsePort(String(f.port))) : [];
}

/** Saves this window's forwards through its host under its remote project. */
function rememberForwards() {
  const session = useRemote.getState().session;
  if (!session) return;
  const all = savedAll();
  const location = remoteLocation(session.sshConfig, session.root);
  const list = savedForwards(usePorts.getState().forwards, session.sshConfig);
  if (list.length) all[location] = list;
  else delete all[location];
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

/** Forwards again what this remote project forwarded last time (another local port when its own is taken). */
export async function restoreForwards(session: RemoteSession) {
  await refreshForwards();
  const current = usePorts.getState().forwards;
  const missing = savedFor(remoteLocation(session.sshConfig, session.root)).filter(
    (s) => !current.some((f) => f.sshConfig === session.sshConfig && f.port === s.port && f.host === s.host),
  );
  for (const s of missing) {
    const request = { sshConfig: session.sshConfig, port: s.port, host: s.host, label: s.label };
    const forwarded = await call(commands.portsForward({ ...request, localPort: s.localPort })).catch(() =>
      forwardPort({ ...request, localPort: null }, { quiet: true }),
    );
    if (!forwarded) break;
  }
  await refreshForwards();
}

// ---------------------------------------------------------------------------
// Listening ports of the remote host

/** Ports already offered (or there when the window connected): offered once each. */
let known = new Set<number>();
let baseline = true;

/** Starts over for a new connection: what listens then is not news. */
export function resetPortWatch() {
  known = new Set();
  baseline = true;
  usePorts.setState({ listening: [] });
}

/** One look at the host's listening ports; offers new ones of applications started from the IDE. */
export async function checkListeningPorts() {
  const session = useRemote.getState().session;
  if (!session) return;
  const listening = await call(commands.machinePorts()).catch(() => null);
  if (!listening || useRemote.getState().session !== session) return;
  usePorts.setState({ listening });
  const forwarded = new Set(
    usePorts
      .getState()
      .forwards.filter((f) => f.sshConfig === session.sshConfig && isOwnHost(f.host))
      .map((f) => f.port),
  );
  const fresh = baseline ? [] : newAppPorts(listening, known, forwarded);
  for (const p of listening) known.add(p.port);
  baseline = false;
  for (const p of fresh) offerPort(session, p);
}

function offerPort(session: RemoteSession, p: ListeningPort) {
  const request = { sshConfig: session.sshConfig, port: p.port, host: "localhost", localPort: null, label: "" };
  notifications().notify({
    level: "info",
    title: tx`Application is listening on port ${p.port}`,
    body: p.command
      ? tx`${p.command} listens on ${session.host}. Forward the port to reach it from this machine.`
      : tx`A process listens on ${session.host}. Forward the port to reach it from this machine.`,
    group: "tools",
    key: `ports.offer:${p.port}`,
    actions: [
      { label: "Forward Port", run: () => void forwardPort(request) },
      { label: "Forward and Open in Browser", run: () => void forwardPort(request, { open: true }) },
    ],
  });
}
