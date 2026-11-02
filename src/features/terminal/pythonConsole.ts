/**
 * PyCharm's Python Console in a Terminal tab: the project interpreter (the remote host's in
 * a remote window) run interactively at the project root, and Execute Selection in Python
 * Console (⌥⇧E), which sends the selection, else the caret line, to it.
 */
import { activeEditor } from "@/editor/api";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { toolWindowService } from "@/workbench/contributions";
import { loadTerminalRuntime } from "./loader";

const NAME = "Python Console";
let open: { tab: string; key: string } | null = null;

async function interpreter(): Promise<string> {
  const python = isTauri() ? await call(commands.sdkPythonEffective()).catch(() => null) : null;
  return python ?? (!isRemoteWindow() && /win/i.test(navigator.platform) ? "python" : "python3");
}

/** Shows the console, starting it when there is none (or it ended); resolves its session key once it runs. */
export async function openPythonConsole(focus = true): Promise<string | null> {
  const root = useProject.getState().project?.root;
  if (!root) return null;
  const rt = await loadTerminalRuntime();
  const state = () => rt.useTerminals.getState();
  const alive =
    open &&
    state().tabs.some((t) => t.id === open!.tab) &&
    !["exited", "error"].includes(state().sessions[open.key]?.status ?? "");
  if (alive) rt.useTerminals.setState({ activeTab: open!.tab });
  else {
    const tab = rt.newTab(root, NAME, { program: await interpreter(), args: ["-i"] });
    open = { tab: tab.id, key: tab.panes[0]! };
  }
  toolWindowService().show("terminal", focus);
  const key = open!.key;
  for (let waited = 0; state().sessions[key]?.status !== "running"; waited += 50) {
    if (waited > 10_000 || ["exited", "error"].includes(state().sessions[key]?.status ?? "")) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
  return key;
}

/**
 * What the console is sent for `code`: one line as typed (the REPL echoes its value), a
 * block as one `exec` of its text, which the plain REPL can't take line by line (indented
 * blocks need a blank line after them, and blank lines inside them end them).
 */
export function consoleInput(code: string): string {
  const text = code.replace(/\s+$/, "");
  if (!text.includes("\n")) return `${text.trim()}\r`;
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return `exec(compile(__import__("base64").b64decode("${btoa(binary)}").decode(), "<selection>", "exec"))\r`;
}

/** Execute Selection in Python Console: the selection, else the caret line. */
export async function executeSelectionInConsole() {
  const editor = activeEditor();
  if (!editor) return;
  const { state } = editor.view;
  const range = state.selection.main;
  const code = range.empty ? state.doc.lineAt(range.head).text : state.sliceDoc(range.from, range.to);
  if (!code.trim()) return;
  const key = await openPythonConsole(false);
  if (!key) return;
  const rt = await loadTerminalRuntime();
  rt.getSession(key)?.send(consoleInput(code));
}
