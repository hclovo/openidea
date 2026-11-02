/**
 * The Python interpreters of the project's machine (the remote host in a remote
 * window) that the Python configuration form offers: the project interpreter,
 * then the detected ones (virtualenvs, pyenv, conda, system).
 */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { projectMachineKey } from "@/platform/remote";

export const usePythonInterpreters = create<{ key: string | null; paths: string[] }>(() => ({
  key: null,
  paths: [],
}));

let loading: string | null = null;

/** The interpreters known for the current project; starts detecting them when they aren't yet. */
export function pythonInterpreters(): string[] {
  const key = projectMachineKey();
  const state = usePythonInterpreters.getState();
  if (state.key === key) return state.paths;
  if (loading !== key && isTauri()) {
    loading = key;
    void Promise.all([
      call(commands.sdkPythonEffective()).catch(() => null),
      call(commands.sdkDetect("python")).catch(() => []),
    ]).then(([effective, detected]) => {
      if (loading === key) loading = null;
      if (projectMachineKey() !== key) return;
      const paths = [effective, ...detected.map((sdk) => sdk.path)].filter((p): p is string => !!p);
      usePythonInterpreters.setState({ key, paths: [...new Set(paths)] });
    });
  }
  return [];
}
