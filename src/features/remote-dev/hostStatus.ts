/**
 * The remote host's status (IDEA's backend control center): CPU, memory, disk
 * and load of the machine a remote window works on, read from its server. A
 * host that stops answering is reported once, with a way to reconnect.
 */
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import { call, commands, type MachineStatus } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";

/** How often the status bar widget reads the host (while the window is visible). */
export const STATUS_INTERVAL_MS = 5000;
/** …and while its details are open. */
export const DETAILS_INTERVAL_MS = 2000;
/** Failed readings in a row before the host counts as lost. */
const LOST_AFTER = 2;
const LOST_KEY = "remote.lost";

interface HostStatusState {
  status: MachineStatus | null;
  /** Why the last reading failed (the connection dropped…); cleared by the next success. */
  error: string | null;
  popupOpen: boolean;
}

export const useHostStatus = create<HostStatusState>(() => ({ status: null, error: null, popupOpen: false }));

let reading: Promise<void> | null = null;
let failures = 0;

export function refreshHostStatus(): Promise<void> {
  const session = useRemote.getState().session;
  if (!session) return Promise.resolve();
  reading ??= (async () => {
    try {
      const status = await call(commands.machineStatus());
      if (failures >= LOST_AFTER) notifications().expire?.(LOST_KEY);
      failures = 0;
      useHostStatus.setState({ status, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      useHostStatus.setState({ error });
      if (++failures === LOST_AFTER && useRemote.getState().session === session) {
        notifications().notify({
          key: LOST_KEY,
          level: "error",
          title: tx`Lost connection to ${session.host}`,
          body: error,
          actions: [{ label: "Reconnect", run: reconnect }],
        });
      }
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/**
 * Reconnects this window: the reloaded window reopens its remote project, on a
 * new server when the old connection is gone (forwarded ports stay with the host).
 */
export function reconnect() {
  window.location.reload();
}

/** Forgets the previous host's readings. */
export function resetHostStatus() {
  failures = 0;
  useHostStatus.setState({ status: null, error: null, popupOpen: false });
}
