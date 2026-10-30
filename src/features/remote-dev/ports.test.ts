import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForwardRequest, ListeningPort, PortForward } from "@/platform/ipc";

const backend = vi.hoisted(() => ({
  forwards: [] as PortForward[],
  listening: [] as ListeningPort[],
  /** Local ports taken on this machine. */
  taken: new Set<number>(),
  next: 1,
}));

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "invalid", message } });
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      portsList: () => Promise.resolve([...backend.forwards]),
      portsStop: (id: number) => {
        backend.forwards = backend.forwards.filter((f) => f.id !== id);
        return Promise.resolve();
      },
      portsForward: (r: ForwardRequest) => {
        const local = r.localPort ?? r.port;
        if (backend.taken.has(local)) {
          if (r.localPort != null) return fail(`Local port ${local} is already in use`);
        }
        const localPort = backend.taken.has(local) ? 40000 + backend.next : local;
        const f: PortForward = {
          id: backend.next++,
          sshConfig: r.sshConfig,
          host: r.host || "localhost",
          port: r.port,
          localPort,
          label: r.label ?? "",
          active: 0,
          total: 0,
          error: null,
        };
        backend.taken.add(localPort);
        backend.forwards.push(f);
        return ok(f);
      },
      machinePorts: () => ok([...backend.listening]),
    },
  };
});

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const { useRemote, remoteLocation } = await import("@/platform/remote");
const { checkListeningPorts, forwardPort, resetPortWatch, restoreForwards, savedFor, stopForwarding, usePorts } =
  await import("./ports");

const session = { sshConfig: "box", root: "/home/dev/app", host: "dev@box", commands: [] };
const listening = (port: number, fromIde: boolean): ListeningPort => ({
  port,
  address: "127.0.0.1",
  pid: 100 + port,
  process: "node",
  command: "node server.js",
  fromIde,
});

describe("ports of a remote window", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(backend, { forwards: [], listening: [], taken: new Set(), next: 1 });
    useRemote.setState({ session });
    usePorts.setState({ forwards: [], listening: [], draft: null });
    resetPortWatch();
    notify.mockClear();
  });
  afterEach(() => useRemote.setState({ session: null }));

  it("offers the ports applications started from the IDE begin to listen on, once each", async () => {
    backend.listening = [listening(22, false), listening(5173, true)];
    await checkListeningPorts();
    expect(notify).not.toHaveBeenCalled();
    expect(usePorts.getState().listening.map((p) => p.port)).toEqual([22, 5173]);

    backend.listening.push(listening(3000, true), listening(9229, false));
    await checkListeningPorts();
    expect(notify.mock.calls.map(([n]) => n.key)).toEqual(["ports.offer:3000"]);

    await checkListeningPorts();
    expect(notify).toHaveBeenCalledTimes(1);

    // "Forward Port" in the notification.
    notify.mock.calls[0]![0].actions[0].run();
    await vi.waitFor(() => expect(usePorts.getState().forwards.map((f) => f.port)).toEqual([3000]));
  });

  it("does not offer a port that is already forwarded", async () => {
    await checkListeningPorts();
    await forwardPort({ sshConfig: "box", port: 8080, host: "", localPort: null, label: "" }, { quiet: true });
    backend.listening = [listening(8080, true)];
    await checkListeningPorts();
    expect(notify).not.toHaveBeenCalled();
  });

  it("remembers forwards per project and forwards them again, elsewhere when the local port is taken", async () => {
    await forwardPort({ sshConfig: "box", port: 3000, host: "", localPort: null, label: "web" }, { quiet: true });
    await forwardPort({ sshConfig: "box", port: 5432, host: "db", localPort: 15432, label: "" }, { quiet: true });
    const location = remoteLocation("box", "/home/dev/app");
    expect(savedFor(location)).toEqual([
      { port: 3000, host: "localhost", localPort: 3000, label: "web" },
      { port: 5432, host: "db", localPort: 15432, label: "" },
    ]);

    // A new session of the project: the forwards are gone, port 3000 is taken here meanwhile.
    Object.assign(backend, { forwards: [], taken: new Set([3000]) });
    await restoreForwards(session);
    const restored = usePorts
      .getState()
      .forwards.map((f) => [f.port, f.host, f.localPort > 40000 ? "any" : f.localPort]);
    expect(restored).toEqual([
      [3000, "localhost", "any"],
      [5432, "db", 15432],
    ]);

    await stopForwarding(usePorts.getState().forwards[1]!);
    expect(savedFor(location).map((f) => f.port)).toEqual([3000]);
  });
});
