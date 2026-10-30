/**
 * The SSH hosts this machine connects, browses and forwards ports with: the
 * saved configurations (Settings › Tools › SSH Configurations), then the hosts
 * of `~/.ssh/config` that none of them connects to yet (`ssh-config:<alias>`).
 * A remote window's settings are its server's, where the saved ones usually
 * don't exist: there they are read from this machine's global settings.
 */
import { useEffect, useMemo, useState } from "react";
import { commands, isTauri, type SshConfigHost } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { sshLabel, validateRemote, type SshConfigValid } from "@/platform/remoteSettings";
import { useWorkflowSettings } from "@/platform/workflowSettings";

/** The last lists read, shown while they are read again. */
let lastLocal: SshConfigValid[] | null = null;
let lastScanned: SshConfigHost[] = [];

/** The saved SSH configurations of this machine. */
export function useSshConfigs(): SshConfigValid[] {
  const remote = useRemote((s) => s.session !== null);
  const own = useWorkflowSettings((s) => s.ssh.configs);
  // Read again when settings change (Settings writes global SSH configurations on both sides).
  const settings = useProject((s) => s.settings);
  const [local, setLocal] = useState<SshConfigValid[] | null>(lastLocal);
  useEffect(() => {
    if (!remote || !isTauri()) return;
    let live = true;
    void commands.settingsGetGlobal().then(
      (global) => {
        lastLocal = validateRemote(global).ssh.configs;
        if (live) setLocal(lastLocal);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [remote, settings]);
  return remote ? (local ?? []) : own;
}

export interface SshHost {
  config: SshConfigValid;
  /** Where it leads: `user@host:port`. */
  target: string;
  /** Listed from `~/.ssh/config`, not a saved configuration. */
  fromSshConfig: boolean;
}

/** Saved configurations, then the hosts of `~/.ssh/config` (read again when the saved ones change). */
export function useSshHosts(): SshHost[] {
  const saved = useSshConfigs();
  const [scanned, setScanned] = useState<SshConfigHost[]>(lastScanned);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void commands.sshConfigHosts().then(
      (r) => {
        if (r.status !== "ok") return;
        lastScanned = r.data;
        if (live) setScanned(r.data);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [saved]);
  return useMemo(
    () => [
      ...saved.map((config) => ({ config, target: sshLabel(config), fromSshConfig: false })),
      ...scanned.flatMap((h) =>
        validateRemote({ ssh: { configs: [h.config] } })
          .ssh.configs.filter((config) => !saved.some((c) => c.id === config.id))
          .map((config) => ({ config, target: h.target, fromSshConfig: true })),
      ),
    ],
    [saved, scanned],
  );
}

/** The name a host is shown by. */
export function hostName(host: SshHost): string {
  return host.config.name.trim() || host.target;
}

/** A host as a choice of a select: its name, then where it leads (and where it was found). */
export function hostOption(host: SshHost): { value: string; label: string; detail: string } {
  const detail = host.fromSshConfig ? `${host.target} · ~/.ssh/config` : host.target;
  return { value: host.config.id, label: hostName(host), detail };
}
