import { describe, expect, it } from "vitest";
import type { MachineStatus, RemoteEntry } from "@/platform/ipc";
import { forgetRemote, parseRemoteLocation, recentRemotes, rememberRemote, remoteLocation } from "@/platform/remote";
import {
  browsableFolders,
  formatLoad,
  isOwnHost,
  listedDirectory,
  newAppPorts,
  parsePort,
  percent,
  remoteAddress,
  remoteBaseName,
  remoteParent,
  resourceLevel,
  savedForwards,
  usedShare,
} from "./model";
import { servesHostStatus } from "./hostStatus";

const entry = (path: string, isDir = true): RemoteEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir,
  isSymlink: false,
  size: 0,
  mtime: null,
  permissions: "rwxr-xr-x",
});

describe("remote folder browser", () => {
  it("goes up one level and stops at the root", () => {
    expect(remoteParent("/home/dev/app")).toBe("/home/dev");
    expect(remoteParent("/home/dev/")).toBe("/home");
    expect(remoteParent("/home")).toBe("/");
    expect(remoteParent("/")).toBe("/");
  });

  it("lists folders only, hidden ones last", () => {
    const names = browsableFolders([
      entry("/h/.cache"),
      entry("/h/zeta"),
      entry("/h/notes.txt", false),
      entry("/h/alpha"),
    ]).map((e) => e.name);
    expect(names).toEqual(["alpha", "zeta", ".cache"]);
  });

  it("resolves `~` from the listing", () => {
    expect(listedDirectory("~", [entry("/home/dev/app")])).toBe("/home/dev");
    expect(listedDirectory("~", [])).toBe("~");
    expect(listedDirectory("/srv/", [])).toBe("/srv");
    expect(listedDirectory("/", [])).toBe("/");
  });
});

describe("remote project locations", () => {
  it("round-trip the configuration id and the path", () => {
    const loc = remoteLocation("mac mini/1", "/Users/me/repo");
    expect(loc).toBe("ssh://mac%20mini%2F1/Users/me/repo");
    expect(parseRemoteLocation(loc)).toEqual({ sshConfig: "mac mini/1", path: "/Users/me/repo" });
    expect(parseRemoteLocation("/Users/me/repo")).toBeNull();
  });

  it("remembers recent remote projects most recent first, once each", () => {
    localStorage.clear();
    rememberRemote({ sshConfig: "a", path: "/p", name: "p", host: "me@a", openedAtMs: 1 });
    rememberRemote({ sshConfig: "b", path: "/q", name: "q", host: "me@b", openedAtMs: 2 });
    rememberRemote({ sshConfig: "a", path: "/p", name: "p", host: "me@a", openedAtMs: 3 });
    expect(recentRemotes().map((r) => r.path)).toEqual(["/p", "/q"]);
    forgetRemote("a", "/p");
    expect(recentRemotes().map((r) => r.path)).toEqual(["/q"]);
  });
});

describe("remote host status", () => {
  const status = (patch: Partial<MachineStatus>): MachineStatus => ({
    hostname: "box",
    os: "Ubuntu 24.04.1 LTS",
    kernel: "6.8.0",
    arch: "x86_64",
    cpus: 8,
    cpu: 0.2,
    load: [0.5, 0.4, 0.3],
    memoryTotal: 16,
    memoryAvailable: 8,
    swapTotal: 0,
    swapFree: 0,
    diskPath: "/home/dev/app",
    diskTotal: 100,
    diskAvailable: 50,
    uptimeSecs: 3600,
    backendMemory: null,
    ...patch,
  });

  it("measures the share in use", () => {
    expect(usedShare(16, 4)).toBe(0.75);
    expect(usedShare(0, 0)).toBeNull();
    expect(percent(0.756)).toBe("76%");
    expect(percent(null)).toBe("–");
    expect(formatLoad([0.5, 1, 12.345])).toBe("0.50  1.00  12.35");
    expect(formatLoad([])).toBe("–");
  });

  it("warns when memory, disk or CPU run short", () => {
    expect(resourceLevel(status({}))).toBe("normal");
    expect(resourceLevel(status({ cpu: 0.95 }))).toBe("low");
    expect(resourceLevel(status({ memoryAvailable: 2 }))).toBe("low");
    expect(resourceLevel(status({ diskAvailable: 4 }))).toBe("critical");
    expect(resourceLevel(status({ memoryAvailable: 0.5 }))).toBe("critical");
  });
});

describe("host status of older servers", () => {
  it("is read only from a server that serves it", () => {
    expect(servesHostStatus({ commands: ["fs_read_dir", "machine_status"] })).toBe(true);
    expect(servesHostStatus({ commands: ["fs_read_dir"] })).toBe(false);
    expect(servesHostStatus(null)).toBe(false);
  });
});

describe("forwarded ports", () => {
  it("reads ports typed in fields", () => {
    expect(parsePort(" 8080 ")).toBe(8080);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("80a")).toBeNull();
  });

  it("names the host a port is reached on", () => {
    expect(isOwnHost("")).toBe(true);
    expect(isOwnHost("127.0.0.1")).toBe(true);
    expect(isOwnHost("db.internal")).toBe(false);
    expect(remoteAddress("localhost", 3000)).toBe("localhost:3000");
    expect(remoteAddress(" db.internal ", 5432)).toBe("db.internal:5432");
    expect(remoteBaseName("/home/dev/app/")).toBe("app");
    expect(remoteBaseName("/")).toBe("/");
  });

  it("remembers the forwards through the window's own host", () => {
    const f = (sshConfig: string, port: number) => ({
      sshConfig,
      port,
      host: "localhost",
      localPort: port + 1,
      label: "",
    });
    expect(savedForwards([f("a", 3000), f("b", 5432)], "a")).toEqual([
      { port: 3000, host: "localhost", localPort: 3001, label: "" },
    ]);
  });

  it("offers new ports of applications started from the IDE, not yet forwarded", () => {
    const p = (port: number, fromIde: boolean) => ({ port, fromIde });
    const ports = [p(22, false), p(3000, true), p(5173, true), p(8888, true)];
    expect(newAppPorts(ports, new Set([5173]), new Set([8888])).map((x) => x.port)).toEqual([3000]);
  });
});
