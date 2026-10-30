/** Forward Port…: a port of an SSH host (or of a host it reaches) to a local port. */
import { useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { Button, Checkbox, Dialog, Input, Select } from "@/ui";
import { parsePort } from "./model";
import { closeForwardDialog, forwardPort, usePorts, type ForwardDraft } from "./ports";
import styles from "./RemoteDev.module.css";
import { hostOption, useSshHosts } from "./sshConfigs";

const SSH_SETTINGS_PAGE = "tools.sshConfigurations";

export function ForwardPortHost() {
  const draft = usePorts((s) => s.draft);
  return draft ? <ForwardPortDialog draft={draft} /> : null;
}

function ForwardPortDialog({ draft }: { draft: ForwardDraft }) {
  const tx = useTx();
  const txt = useTxTemplate();
  const hosts = useSshHosts();
  // The hosts of ~/.ssh/config arrive after the dialog opens: until one is chosen, the first host.
  const [chosen, setSsh] = useState(draft.sshConfig);
  const ssh = chosen || hosts[0]?.config.id || "";
  const [port, setPort] = useState(draft.port ? String(draft.port) : "");
  const [host, setHost] = useState(draft.host);
  const [local, setLocal] = useState(draft.localPort ? String(draft.localPort) : "");
  const [label, setLabel] = useState(draft.label);
  const [open, setOpen] = useState(draft.openInBrowser);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remotePort = parsePort(port);
  const localPort = local.trim() ? parsePort(local) : null;
  const invalid =
    (port.trim() && !remotePort) || (local.trim() && !localPort)
      ? "The port number should be between 1 and 65535"
      : null;
  const ready = !!ssh && !!remotePort && !invalid && !busy;

  const submit = async () => {
    if (!ready || !remotePort) return;
    setBusy(true);
    setError(null);
    try {
      await forwardPort(
        { sshConfig: ssh, port: remotePort, host: host.trim(), localPort, label },
        { open, throws: true },
      );
      closeForwardDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const options = hosts.map(hostOption);
  return (
    <Dialog
      open
      title={tx("Forward Port")}
      onClose={closeForwardDialog}
      width={480}
      buttons={[
        {
          label: busy ? "Forwarding…" : "Forward Port",
          role: "default",
          disabled: !ready,
          onClick: () => void submit(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className={styles.hint}>
          {tx("Connections to the local port reach the port as the SSH host sees it, like ssh -L.")}
        </p>
        <label className={styles.label}>{tx("SSH configuration:")}</label>
        <div className={styles.row}>
          <Select
            className={styles.grow}
            value={ssh || null}
            options={options}
            placeholder={tx("No SSH configurations")}
            onChange={setSsh}
            aria-label={tx("SSH configuration")}
          />
          <Button onClick={() => void executeAction("file.settings", SSH_SETTINGS_PAGE)}>{tx("Configure…")}</Button>
        </div>
        <div className={styles.grid}>
          <label className={styles.label} htmlFor="forward-port">
            {tx("Remote port:")}
          </label>
          <Input
            id="forward-port"
            data-autofocus
            inputMode="numeric"
            value={port}
            placeholder="3000"
            spellCheck={false}
            onChange={(e) => {
              setPort(e.target.value);
              setError(null);
            }}
          />
          <label className={styles.label} htmlFor="forward-host">
            {tx("Remote host:")}
          </label>
          <Input
            id="forward-host"
            value={host}
            placeholder="localhost"
            spellCheck={false}
            onChange={(e) => {
              setHost(e.target.value);
              setError(null);
            }}
          />
          <span />
          <span className={styles.fieldHint}>
            {tx("localhost is the SSH host itself; another name is resolved there.")}
          </span>
          <label className={styles.label} htmlFor="forward-local">
            {tx("Local port:")}
          </label>
          <Input
            id="forward-local"
            inputMode="numeric"
            value={local}
            placeholder={tx("Same as the remote port when free")}
            spellCheck={false}
            onChange={(e) => {
              setLocal(e.target.value);
              setError(null);
            }}
          />
          <label className={styles.label} htmlFor="forward-label">
            {tx("Name:")}
          </label>
          <Input
            id="forward-label"
            value={label}
            placeholder={tx("Optional")}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Checkbox checked={open} onChange={setOpen} label="Open in browser" />
        {(invalid || error) && (
          <div className={styles.error} role="alert">
            {invalid ? tx(invalid) : txt(error ?? "")}
          </div>
        )}
      </form>
    </Dialog>
  );
}
