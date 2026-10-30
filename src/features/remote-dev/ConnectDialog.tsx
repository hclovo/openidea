/**
 * Picks an SSH configuration and a folder on that host, then opens it in this
 * or a new window. In a remote window it starts on that host, next to the open
 * project (File › Open… there browses the host, not this machine).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { call, commands, type RemoteEntry } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { recentRemotes, useRemote, useRemoteProgress, withSshRetry } from "@/platform/remote";
import { Button, Dialog, Icon, Input, ProgressBar, Select, Spinner, type DialogButton } from "@/ui";
import { openPolicy, openRemoteProject } from "@/workbench/projectWindow";
import { openLocalProjectDialog } from "@/workbench/shellActions";
import {
  browsableFolders,
  closeConnectDialog,
  listedDirectory,
  remoteBaseName,
  remoteParent,
  stageLabel,
  useConnectDialog,
  type ConnectRequest,
} from "./model";
import styles from "./RemoteDev.module.css";
import { hostOption, useSshHosts } from "./sshConfigs";

export function ConnectHost() {
  const open = useConnectDialog((s) => s.open);
  const request = useConnectDialog((s) => s.request);
  return open ? <ConnectDialog request={request} /> : null;
}

const SSH_SETTINGS_PAGE = "tools.sshConfigurations";
const RECENT_SHOWN = 6;

function ConnectDialog({ request }: { request: ConnectRequest }) {
  const tx = useTx();
  const hosts = useSshHosts();
  const session = useRemote((s) => s.session);
  const hasProject = useProject((s) => !!s.project || s.lightEdit);
  const startHost = request.sshConfig ?? session?.sshConfig;
  // The hosts of ~/.ssh/config arrive after the dialog opens: until one is chosen, the first host.
  const [chosen, setSsh] = useState(startHost ?? "");
  const ssh = chosen || hosts[0]?.config.id || "";
  const [path, setPath] = useState(
    request.path ?? (session && session.sshConfig === ssh ? remoteParent(session.root) : "~"),
  );
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browse, setBrowse] = useState<{ dir: string; folders: RemoteEntry[] } | null>(null);
  const connecting = useRemoteProgress((s) => s.progress !== null);

  // Only the latest listing shows: a folder clicked while another loads wins.
  const listings = useRef(0);
  const list = async (dir: string) => {
    if (!ssh) return;
    const request = ++listings.current;
    setError(null);
    setListing(true);
    try {
      const entries = await withSshRetry(ssh, () => call(commands.remoteList(ssh, dir)));
      if (request !== listings.current) return;
      const shown = listedDirectory(dir, entries);
      setBrowse({ dir: shown, folders: browsableFolders(entries) });
      setPath(shown);
    } catch (e) {
      if (request === listings.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === listings.current) setListing(false);
    }
  };

  // A host chosen for us (this window's, or a host's "Open Folder…"): show its folders right away.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (startHost && ssh === startHost) void list(path.trim() || "~");
    // Once, for the starting host and folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recent = useMemo(
    () =>
      recentRemotes()
        .filter((r) => r.sshConfig === ssh && r.path !== session?.root)
        .slice(0, RECENT_SHOWN),
    [ssh, session?.root],
  );

  const open = async (mode?: "new" | "same") => {
    setError(null);
    setBusy(true);
    try {
      const target = path.trim() || "~";
      if (await openRemoteProject(ssh, target, undefined, mode)) closeConnectDialog();
      else setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const options = hosts.map(hostOption);
  const ready = !!ssh && !busy && !!path.trim();
  const preferNew = request.target === "new" || openPolicy() === "new";
  const buttons: DialogButton[] = !hasProject
    ? [{ label: connecting ? "Connecting…" : "Open", role: "default", disabled: !ready, onClick: () => void open() }]
    : [
        {
          label: "New Window",
          role: preferNew ? "default" : "extra",
          disabled: !ready,
          onClick: () => void open("new"),
        },
        {
          label: connecting ? "Connecting…" : "This Window",
          role: preferNew ? "extra" : "default",
          disabled: !ready,
          onClick: () => void open("same"),
        },
      ];
  buttons.push({ label: "Cancel", role: "cancel" });

  return (
    <Dialog
      open
      title={tx(session ? "Open Folder on Remote Host" : "Remote Development")}
      onClose={closeConnectDialog}
      width={580}
      buttons={buttons}
      footerStart={
        session ? (
          <Button
            variant="ghost"
            onClick={() => {
              closeConnectDialog();
              void openLocalProjectDialog();
            }}
          >
            {tx("Open Local Folder…")}
          </Button>
        ) : undefined
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void open(hasProject ? (preferNew ? "new" : "same") : undefined);
        }}
      >
        <p className={styles.hint}>
          {tx("The project runs on the remote host; the IDE backend is installed there on first use.")}
        </p>
        <label className={styles.label}>{tx("SSH configuration:")}</label>
        <div className={styles.row}>
          <Select
            className={styles.grow}
            value={ssh || null}
            options={options}
            placeholder={tx("No SSH configurations")}
            onChange={(id) => {
              setSsh(id);
              setBrowse(null);
              setError(null);
              if (id !== ssh) setPath("~");
            }}
            aria-label={tx("SSH configuration")}
          />
          <Button onClick={() => void executeAction("file.settings", SSH_SETTINGS_PAGE)}>{tx("Configure…")}</Button>
        </div>
        <label className={styles.label} htmlFor="remote-dev-path">
          {tx("Project directory:")}
        </label>
        <div className={styles.row}>
          <Input
            id="remote-dev-path"
            className={styles.grow}
            data-autofocus
            value={path}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button disabled={!ssh || listing} onClick={() => void list(path.trim() || "~")}>
            {tx("Browse")}
          </Button>
        </div>
        {recent.length > 0 && (
          <div className={styles.recentRow} aria-label={tx("Recent folders on this host")}>
            <span className={styles.recentLabel}>{tx("Recent:")}</span>
            {recent.map((r) => (
              <button
                key={r.path}
                type="button"
                className={styles.recentChip}
                title={r.path}
                onClick={() => {
                  setPath(r.path);
                  void list(r.path);
                }}
              >
                {r.name || remoteBaseName(r.path)}
              </button>
            ))}
          </div>
        )}
        {(browse || listing) && (
          <ul className={styles.folders} aria-label={tx("Remote folders")} aria-busy={listing || undefined}>
            {listing && (
              <li className={styles.listing}>
                <Spinner size={12} />
              </li>
            )}
            {browse && browse.dir !== "/" && (
              <li>
                <button type="button" className={styles.folder} onClick={() => void list(remoteParent(browse.dir))}>
                  <Icon name="folder" />
                  ..
                </button>
              </li>
            )}
            {browse?.folders.map((f) => (
              <li key={f.path}>
                <button type="button" className={styles.folder} onClick={() => void list(f.path)}>
                  <Icon name="folder" />
                  {f.name}
                </button>
              </li>
            ))}
            {browse && !listing && browse.folders.length === 0 && (
              <li className={styles.noFolders}>{tx("No folders here")}</li>
            )}
          </ul>
        )}
        <ConnectProgress />
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** The stage of the connection in progress (and how far a download / upload is). */
function ConnectProgress() {
  const tx = useTx();
  const progress = useRemoteProgress((s) => s.progress);
  if (!progress) return null;
  const percent = progress.fraction == null ? null : Math.round(progress.fraction * 100);
  return (
    <div className={styles.progress} role="status">
      <div className={styles.progressLine}>
        <Spinner size={12} />
        <span>{tx(stageLabel(progress.stage))}</span>
        {percent != null && <span className={styles.percent}>{percent}%</span>}
      </div>
      <ProgressBar value={progress.fraction} aria-label={tx(stageLabel(progress.stage))} />
    </div>
  );
}
