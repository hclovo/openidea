/** Runs remote work, offering to trust an unknown host key or asking for a password when that is what failed. */
import { call, commands, IpcError } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { confirm } from "@/workbench/messages";
import { sshRemedy } from "./model";
import { promptSecret } from "./store";

/** Questions being asked per SSH configuration and remedy: work failing meanwhile waits for the same answer. */
const asking = new Map<string, Promise<boolean>>();

function askOnce(ssh: string, remedy: string, ask: () => Promise<boolean>): Promise<boolean> {
  const key = `${remedy}:${ssh}`;
  let answer = asking.get(key);
  if (!answer) {
    answer = ask().finally(() => asking.delete(key));
    asking.set(key, answer);
  }
  return answer;
}

export async function withSsh<T>(ssh: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= 3 || !(e instanceof IpcError) || !ssh) throw e;
      const auth = workflowSettings().ssh.configs.find((c) => c.id === ssh)?.auth ?? "openSsh";
      const remedy = sshRemedy(e.kind, e.message, auth);
      if (remedy === "trustHostKey") {
        const trusted = await askOnce(ssh, remedy, async () => {
          const ok = await confirm({
            title: "Unknown Host Key",
            message: e.message,
            ok: "Trust and Connect",
            icon: "warning",
          });
          if (ok) await call(commands.sshTrustHost(ssh));
          return ok;
        });
        if (!trusted) throw e;
      } else if (remedy === "secret") {
        const given = await askOnce(ssh, remedy, async () => {
          const answer = await promptSecret(ssh, e.message);
          if (answer) await commands.sshSetSecret(ssh, answer.secret, answer.save);
          return !!answer;
        });
        if (!given) throw e;
      } else throw e;
    }
  }
}
