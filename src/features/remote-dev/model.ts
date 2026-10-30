/** File › Remote Development…: state of the connect dialog, the folder browser helpers and host status levels. */
import { create } from "zustand";
import type { MachineStatus, RemoteEntry, RemoteStage } from "@/platform/ipc";

/** What the connect dialog starts with. */
export interface ConnectRequest {
  /** SSH configuration to preselect (default: this window's host, else the first). */
  sshConfig?: string;
  /** Folder to start in (default: next to this window's remote project, else `~`). */
  path?: string;
  /** `new`: the folder opens in a new window; otherwise as the user picks. */
  target?: "new";
}

export const useConnectDialog = create<{ open: boolean; request: ConnectRequest }>(() => ({
  open: false,
  request: {},
}));

export function openConnectDialog(request: ConnectRequest = {}) {
  useConnectDialog.setState({ open: true, request });
}

export function closeConnectDialog() {
  useConnectDialog.setState({ open: false, request: {} });
}

/** The parent of absolute POSIX path `path` (`/` stays `/`). */
export function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** The last segment of a remote path (`/` and `~` stay as they are). */
export function remoteBaseName(path: string): string {
  const trimmed = path.replace(/(.)\/+$/, "$1");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** The folders of a listing, sorted by name (hidden ones last). */
export function browsableFolders(entries: readonly RemoteEntry[]): RemoteEntry[] {
  const hidden = (e: RemoteEntry) => e.name.startsWith(".");
  return entries
    .filter((e) => e.isDir)
    .sort((a, b) => Number(hidden(a)) - Number(hidden(b)) || a.name.localeCompare(b.name));
}

/** The directory a listing of `requested` stands for (`~` resolves on the server). */
export function listedDirectory(requested: string, entries: readonly RemoteEntry[]): string {
  if (requested.startsWith("/")) return requested.replace(/(.)\/+$/, "$1");
  const first = entries[0];
  return first ? remoteParent(first.path) : requested;
}

/** What the window is waiting for at each stage of connecting. */
export function stageLabel(stage: RemoteStage): string {
  switch (stage) {
    case "connecting":
      return "Connecting to the host…";
    case "checking":
      return "Checking the IDE backend on the host…";
    case "downloading":
      return "Downloading the IDE backend…";
    case "uploading":
      return "Installing the IDE backend on the host…";
    case "starting":
      return "Starting the IDE backend…";
    case "opening":
      return "Opening the project…";
  }
}

// ---------------------------------------------------------------------------
// Host status

/** Share of `total` in use (0..1), `null` when unknown. */
export function usedShare(total: number, available: number): number | null {
  if (!(total > 0)) return null;
  return Math.min(1, Math.max(0, (total - available) / total));
}

/** IDEA's "Resources low / critical" of the backend control center. */
export type ResourceLevel = "normal" | "low" | "critical";

export function resourceLevel(s: MachineStatus): ResourceLevel {
  const memory = usedShare(s.memoryTotal, s.memoryAvailable) ?? 0;
  const disk = usedShare(s.diskTotal, s.diskAvailable) ?? 0;
  if (memory >= 0.95 || disk >= 0.95) return "critical";
  if (memory >= 0.85 || disk >= 0.9 || (s.cpu ?? 0) >= 0.9) return "low";
  return "normal";
}

/** `42%` (rounded; `–` when unknown). */
export function percent(share: number | null | undefined): string {
  return share == null || !Number.isFinite(share) ? "–" : `${Math.round(share * 100)}%`;
}

/** `0.52  0.61  0.70` */
export function formatLoad(load: readonly (number | null)[]): string {
  return load.length ? load.map((l) => (l == null ? "–" : l.toFixed(2))).join("  ") : "–";
}

// ---------------------------------------------------------------------------
// Ports

/** A port typed in a field: 1…65535, else `null`. */
export function parsePort(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = parseInt(text, 10);
  return n > 0 && n <= 65535 ? n : null;
}

/** The host a port is reached on as the SSH host sees it: itself unless another host is named. */
export function isOwnHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "" || h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/** `localhost:3000`, or `db.internal:5432` for another host. */
export function remoteAddress(host: string, port: number): string {
  return `${isOwnHost(host) ? "localhost" : host.trim()}:${port}`;
}

/** A forwarded port to bring back when the project is opened again. */
export interface SavedForward {
  port: number;
  host: string;
  localPort: number;
  label: string;
}

/** The forwards worth remembering: those through the window's own host. */
export function savedForwards(
  forwards: readonly { sshConfig: string; port: number; host: string; localPort: number; label: string }[],
  sshConfig: string,
): SavedForward[] {
  return forwards
    .filter((f) => f.sshConfig === sshConfig)
    .map(({ port, host, localPort, label }) => ({ port, host, localPort, label }));
}

/** Of the listening ports, the new ones an application started from the IDE opened: worth offering. */
export function newAppPorts<P extends { port: number; fromIde: boolean }>(
  ports: readonly P[],
  known: ReadonlySet<number>,
  forwarded: ReadonlySet<number>,
): P[] {
  return ports.filter((p) => p.fromIde && !known.has(p.port) && !forwarded.has(p.port));
}
