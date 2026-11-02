/**
 * Built-in run configuration types (Shell Script, Program, npm, Gradle, Maven,
 * Application, Spring Boot, Compound) and the helpers that turn a type's params into the launched
 * command line. Other features contribute types with `registerRunConfigType`.
 */
import { isJvmApplication, parseJavaArgs } from "@/platform/javaLaunch";
import type { RunConfig } from "@/platform/ipc";
import {
  registerRunConfigType,
  useRunConfigTypes,
  type RunConfigTypeContribution,
  type RunConfigTypeField,
} from "@/workbench/contributions";
import { formatArgs, parseArgs, uid, uniqueName } from "./configs";
import { commandName } from "./commandName";
import {
  applicationType,
  gradleForkedJvm,
  isWindows,
  mavenForkedJvm,
  springBootType,
  type ForkedJvm,
} from "./jvmTypes";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { appModule } from "./fastapi";
import { pythonInterpreters } from "./pythonInterpreters";

import { tomcatType } from "./tomcat";
import { goBuildType, goTestType } from "./goTypes";

import { dotnetProjectType, dotnetTestType } from "./dotnetTypes";

export const COMPOUND = "compound";

const on = (v: string | undefined) => v === "true";
const dirOf = (cwd: string | null | undefined) => cwd ?? "";

/** Values of `args[index]` across detected configurations of `kind`. */
function argsOf(configs: readonly RunConfig[], kind: string, index: number): string[] {
  const out = new Set<string>();
  for (const c of configs) if (c.kind === kind && c.args[index]) out.add(c.args[index]);
  return [...out];
}

const shell: RunConfigTypeContribution = {
  id: "shell",
  label: "Shell Script",
  icon: "file-shell",
  description: "Run a script file, script text or command line",
  defaults: { mode: "file" },
  fields: [
    {
      key: "mode",
      label: "Execute",
      control: "select",
      options: [
        { value: "file", label: "Script file" },
        { value: "text", label: "Script text" },
        { value: "command", label: "Command line" },
      ],
    },
    { key: "path", label: "Script path", mono: true, required: true, visible: (p) => p.mode === "file" },
    { key: "options", label: "Script options", mono: true, visible: (p) => p.mode === "file" },
    {
      key: "interpreter",
      label: "Interpreter path",
      mono: true,
      placeholder: "Run the script directly",
      visible: (p) => p.mode === "file",
    },
    {
      key: "interpreterOptions",
      label: "Interpreter options",
      mono: true,
      visible: (p) => p.mode === "file" && !!p.interpreter,
    },
    {
      key: "script",
      label: "Script text",
      control: "textarea",
      mono: true,
      required: true,
      visible: (p) => p.mode === "text",
    },
    {
      key: "command",
      label: "Command",
      mono: true,
      required: true,
      placeholder: "e.g. ./gradlew or cargo",
      visible: (p) => p.mode === "command",
    },
    {
      key: "args",
      label: "Arguments",
      mono: true,
      placeholder: "Space separated; quote with ' or \"",
      visible: (p) => p.mode === "command",
    },
  ],
  commandLine(p) {
    if (p.mode === "text") return { command: p.script ?? "", args: [] };
    if (p.mode === "file") {
      const path = p.path ?? "";
      if (!p.interpreter?.trim()) return { command: path, args: parseArgs(p.options ?? "") };
      return {
        command: p.interpreter.trim(),
        args: [...parseArgs(p.interpreterOptions ?? ""), path, ...parseArgs(p.options ?? "")],
      };
    }
    return { command: p.command ?? "", args: parseArgs(p.args ?? "") };
  },
  paramsFrom: (c) => ({ mode: "command", command: c.command, args: formatArgs(c.args) }),
};

const program: RunConfigTypeContribution = {
  id: "program",
  label: "Program",
  icon: "file-binary",
  description: "Run an executable with arguments",
  fields: [
    { key: "program", label: "Executable", mono: true, required: true, placeholder: "Path or command on PATH" },
    { key: "arguments", label: "Program arguments", mono: true },
  ],
  commandLine: (p) => ({ command: p.program ?? "", args: parseArgs(p.arguments ?? "") }),
  paramsFrom: (c) =>
    c.args.length || !/\s/.test(c.command) ? { program: c.command, arguments: formatArgs(c.args) } : null,
};

const isScene = (a: string) => /\.t?scn$/i.test(a);
const isGodot = (cmd: string) => /^godot([-.\w]*)$/i.test(commandName(cmd));

/**
 * Godot: `godot --path <project>` runs the main scene, `… <scene>` one scene. The
 * executable is the one from Settings › Language Servers › godot (else detected).
 */
const godot: RunConfigTypeContribution = {
  id: "godot",
  label: "Godot",
  icon: "file-gdscript",
  description: "Run a Godot project's main scene or a chosen scene",
  ownsWorkingDirectory: true,
  debugAdapter: "godot",
  fields: [
    { key: "projectDir", label: "Project directory", mono: true, placeholder: "Project root (holds project.godot)" },
    {
      key: "scene",
      label: "Scene",
      mono: true,
      placeholder: "Main scene",
      hint: "e.g. res://levels/level_1.tscn; empty runs the project's main scene",
      suggestions: (configs) => [
        ...new Set(configs.filter((c) => c.kind === "godot").flatMap((c) => c.args.filter(isScene))),
      ],
    },
    {
      key: "arguments",
      label: "Arguments",
      mono: true,
      placeholder: "Godot command line options, e.g. --debug-collisions",
    },
  ],
  commandLine: (p) => ({
    command: p.executable || "godot",
    args: ["--path", ".", ...(p.scene?.trim() ? [p.scene.trim()] : []), ...parseArgs(p.arguments ?? "")],
    cwd: p.projectDir?.trim() || null,
  }),
  paramsFrom(c) {
    if (!isGodot(c.command)) return null;
    const rest = [...c.args];
    const path = rest.indexOf("--path");
    if (path >= 0) rest.splice(path, 2);
    const scene = rest.find(isScene) ?? "";
    return {
      projectDir: dirOf(c.cwd),
      scene,
      arguments: formatArgs(rest.filter((a) => a !== scene)),
      ...(c.command !== "godot" ? { executable: c.command } : {}),
    };
  },
};

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const NPM_COMMANDS = ["run", "test", "start", "install", "ci", "publish", "pack"];

const npm: RunConfigTypeContribution = {
  id: "npm",
  label: "npm",
  icon: "file-npm",
  description: "Run a package.json script",
  defaults: { packageManager: "npm", command: "run" },
  ownsWorkingDirectory: true,
  fields: [
    { key: "packageDir", label: "package.json directory", mono: true, placeholder: "Project root" },
    { key: "command", label: "Command", control: "select", options: NPM_COMMANDS.map((v) => ({ value: v, label: v })) },
    {
      key: "script",
      label: "Script",
      mono: true,
      required: true,
      visible: (p) => p.command === "run",
      suggestions: (configs) => argsOf(configs, "npm", 1),
    },
    { key: "arguments", label: "Arguments", mono: true },
    {
      key: "packageManager",
      label: "Package manager",
      control: "select",
      options: PACKAGE_MANAGERS.map((v) => ({ value: v, label: v })),
    },
  ],
  commandLine(p) {
    const command = p.command || "run";
    const args = [command, ...(command === "run" ? [p.script ?? ""] : []), ...parseArgs(p.arguments ?? "")];
    const manager = p.packageManager || "npm";
    const executable = p.executable && commandName(p.executable) === manager ? p.executable : manager;
    return { command: executable, args, cwd: p.packageDir?.trim() || null };
  },
  paramsFrom(c) {
    const [command, ...rest] = c.args;
    if (!PACKAGE_MANAGERS.includes(commandName(c.command)) || !command || !NPM_COMMANDS.includes(command)) return null;
    const script = command === "run" ? (rest.shift() ?? "") : "";
    return {
      packageManager: commandName(c.command),
      command,
      script,
      arguments: formatArgs(rest),
      packageDir: dirOf(c.cwd),
      ...(c.command !== commandName(c.command) ? { executable: c.command } : {}),
    };
  },
};

function wrapperCommand(unix: string, windows: string, plain: string, wrapper: boolean): string {
  if (!wrapper) return plain;
  return isWindows() ? windows : `./${unix}`;
}

function buildToolType(
  id: string,
  label: string,
  icon: string,
  tasks: { label: string; description: string },
  wrapper: { unix: string; windows: string; plain: string; label: string; byDefault: boolean },
  jvm: ForkedJvm,
): RunConfigTypeContribution {
  return {
    id,
    label,
    icon,
    description: tasks.description,
    defaults: wrapper.byDefault ? { wrapper: "true" } : {},
    ownsWorkingDirectory: true,
    fields: [
      { key: "projectDir", label: tx`${label} project`, mono: true, placeholder: "Project root" },
      {
        key: "tasks",
        label: tasks.label,
        mono: true,
        required: true,
        suggestions: (configs) => argsOf(configs, id, 0),
      },
      { key: "arguments", label: "Arguments", mono: true },
      ...jvm.fields,
      { key: "wrapper", label: wrapper.label, control: "checkbox" },
    ],
    commandLine: (p) => ({
      command:
        p.executable && commandName(p.executable) === (on(p.wrapper) ? wrapper.unix : wrapper.plain)
          ? p.executable
          : wrapperCommand(wrapper.unix, wrapper.windows, wrapper.plain, on(p.wrapper)),
      args: [...parseArgs(p.tasks ?? ""), ...parseArgs(p.arguments ?? ""), ...jvm.args(p)],
      cwd: p.projectDir?.trim() || null,
    }),
    ...(jvm.prepareLaunch ? { prepareLaunch: jvm.prepareLaunch } : {}),
    paramsFrom(c) {
      const name = commandName(c.command);
      const usesWrapper = name === wrapper.unix;
      if (!usesWrapper && name !== wrapper.plain) return null;
      return {
        executable: c.command,
        projectDir: dirOf(c.cwd),
        tasks: formatArgs(c.args),
        arguments: "",
        ...(usesWrapper ? { wrapper: "true" } : {}),
      };
    },
  };
}

const gradle = buildToolType(
  "gradle",
  "Gradle",
  "file-gradle",
  { label: "Tasks", description: "Run Gradle tasks" },
  {
    unix: "gradlew",
    windows: "gradlew.bat",
    plain: "gradle",
    label: "Use the Gradle wrapper",
    byDefault: true,
  },
  gradleForkedJvm,
);

const maven = buildToolType(
  "maven",
  "Maven",
  "file-maven",
  { label: "Goals", description: "Run Maven goals" },
  {
    unix: "mvnw",
    windows: "mvnw.cmd",
    plain: "mvn",
    label: "Use the Maven wrapper",
    byDefault: false,
  },
  mavenForkedJvm,
);

const compound: RunConfigTypeContribution = {
  id: COMPOUND,
  label: "Compound",
  icon: "gutter-run-all",
  description: "Run or debug several configurations together",
  fields: [],
  commandLine: () => null,
};

/**
 * pytest: what comes after the `pytest` invocation — a target (directory, file,
 * test id) and options. The command itself is one word (`pytest`, `uv`,
 * `.venv/bin/pytest`, `python`), the runner args its leading arguments
 * (`run pytest`, `-m pytest`, none).
 */
const pytest: RunConfigTypeContribution = {
  id: "pytest",
  label: "pytest",
  icon: "file-python",
  description: "Run pytest tests",
  defaults: { command: "pytest" },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "pytest",
      required: true,
      hint: "e.g. pytest, uv, poetry, .venv/bin/pytest, python",
    },
    {
      key: "runnerArgs",
      label: "Runner arguments",
      mono: true,
      placeholder: "run pytest",
      hint: "e.g. `run pytest` for uv/poetry, `-m pytest` for python; empty calls the command itself",
    },
    {
      key: "target",
      label: "Target",
      mono: true,
      placeholder: "tests",
      hint: "Directory, file or test id; empty runs the whole suite",
    },
    { key: "options", label: "pytest options", mono: true, placeholder: "e.g. -x -q --tb=short" },
  ],
  commandLine(p) {
    const args = parseArgs(p.runnerArgs ?? "");
    if (p.target?.trim()) args.push(...parseArgs(p.target.trim()));
    args.push(...parseArgs(p.options ?? ""));
    return { command: p.command?.trim() || "pytest", args };
  },
  paramsFrom(c) {
    if (c.kind !== "pytest") return null;
    // The runner part (`run pytest`, `-m pytest`, none when the command is
    // pytest itself); what follows is the target and pytest options.
    const m = c.args.indexOf("-m");
    const runner =
      c.args[0] === "run" && c.args[1] === "pytest"
        ? 2
        : m >= 0 && c.args[m + 1] === "pytest"
          ? m + 2
          : commandName(c.command) === "pytest"
            ? 0
            : null;
    if (runner === null) return null;
    const rest = c.args.slice(runner);
    const [target, ...options] = rest;
    return {
      command: c.command,
      runnerArgs: formatArgs(c.args.slice(0, runner)),
      target: target && !target.startsWith("-") ? formatArgs([target]) : "",
      options: formatArgs(target && !target.startsWith("-") ? options : rest),
    };
  },
};

/** Interpreter options that take their value as the next argument (`-X dev`, `-W error`). */
const PYTHON_VALUE_OPTIONS = new Set(["-X", "-W", "--check-hash-based-pycs"]);
/** Commands that run Python in the project's environment (`uv run python …`), as the backend knows them. */
const PYTHON_RUNNERS = new Set(["uv", "poetry", "pdm"]);
const isPythonCommand = (command: string) => /^python(3(\.\d+)?)?$/.test(commandName(command));
/** An interpreter the form shows as one: `python3.12`, `.venv/bin/python`, `pypy3`, Windows' `py`. */
const isInterpreter = (command: string) => /^(python|pypy)|^py$/i.test(commandName(command));
/** Remote hosts are Linux or macOS; only a local Windows machine splits paths there. */
const windowsHost = () => isWindows() && !isRemoteWindow();
const splitPython = (text: string | undefined) => parseArgs(text ?? "", windowsHost());

/** The form of a Python command line; null when it runs no script or module (`-c` code, stdin, the REPL). */
/** The interpreter (with a runner's `run python`) of a Python command line, and the arguments after it. */
function splitInterpreter(c: RunConfig): { interpreter: string; args: string[] } | null {
  const args = [...c.args];
  const interpreter = [c.command];
  if (PYTHON_RUNNERS.has(commandName(c.command)) && args[0] === "run") {
    interpreter.push(args.shift()!);
    if (args[0] && isPythonCommand(args[0])) interpreter.push(args.shift()!);
  } else if (!isInterpreter(c.command)) return null;
  return { interpreter: formatArgs(interpreter), args };
}

function pythonParams(c: RunConfig): Record<string, string> | null {
  if (c.kind !== "python") return null;
  const split = splitInterpreter(c);
  if (!split) return null;
  const { interpreter, args } = split;
  const options: string[] = [];
  while (args[0]?.startsWith("-") && args[0] !== "-m") {
    const option = args.shift()!;
    if (option === "-c" || option === "-") return null;
    options.push(option);
    if (PYTHON_VALUE_OPTIONS.has(option) && args.length) options.push(args.shift()!);
  }
  const module = args[0] === "-m";
  if (module) args.shift();
  const target = args.shift();
  if (!target) return null;
  return {
    interpreter,
    mode: module ? "module" : "script",
    ...(module ? { module: target } : { script: target }),
    parameters: formatArgs(args),
    options: formatArgs(options),
  };
}

/** The interpreter of a Python or FastAPI configuration: empty runs the project interpreter. */
const interpreterField: RunConfigTypeField = {
  key: "interpreter",
  label: "Python interpreter",
  mono: true,
  placeholder: "Project interpreter",
  hint: "Empty uses the project interpreter; e.g. .venv/bin/python or uv run python",
  suggestions: (configs) => [
    ...new Set([
      ...pythonInterpreters(),
      ...configs.flatMap((c) =>
        c.kind === "python" || c.kind === "fastapi" ? (splitInterpreter(c)?.interpreter ?? []) : [],
      ),
    ]),
  ],
};

/** A command line's interpreter: the one typed, else `python3` (`python` on Windows) for the project's. */
const interpreterLine = (interpreter: string | undefined) => {
  const [command = windowsHost() ? "python" : "python3", ...runner] = splitPython(interpreter);
  return { command, runner };
};

/**
 * Python (PyCharm's Python configuration): a script, or a module run with `-m`.
 * An empty interpreter runs `python3`, which the backend points at the project
 * interpreter (the one chosen in settings, else the project's virtualenv); the
 * interpreter may carry a runner (`uv run python`). In a remote window all of it
 * is on the remote host.
 */
const python: RunConfigTypeContribution = {
  id: "python",
  label: "Python",
  icon: "file-python",
  description: "Run a Python script or module",
  defaults: { mode: "script" },
  debugAdapter: "debugpy",
  fields: [
    interpreterField,
    {
      key: "mode",
      label: "Execute",
      control: "select",
      options: [
        { value: "script", label: "Script path" },
        { value: "module", label: "Module name" },
      ],
    },
    {
      key: "script",
      label: "Script path",
      mono: true,
      required: true,
      placeholder: "main.py",
      hint: "Relative to the working directory",
      visible: (p) => p.mode !== "module",
    },
    {
      key: "module",
      label: "Module name",
      mono: true,
      required: true,
      placeholder: "package.module",
      visible: (p) => p.mode === "module",
      validate: (v) => (/^[A-Za-z_][\w.]*$/.test(v) ? null : "Not a module name"),
    },
    { key: "parameters", label: "Script parameters", mono: true },
    { key: "options", label: "Interpreter options", mono: true, placeholder: "e.g. -X dev -W error" },
  ],
  commandLine(p) {
    const { command, runner } = interpreterLine(p.interpreter);
    const target = p.mode === "module" ? ["-m", p.module?.trim() ?? ""] : [p.script?.trim() ?? ""];
    return { command, args: [...runner, ...splitPython(p.options), ...target, ...splitPython(p.parameters)] };
  },
  paramsFrom: pythonParams,
};

const IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * FastAPI (PyCharm's FastAPI configuration): uvicorn serving the application object of an
 * application file, `python -m uvicorn app.main:app --reload`, with the project interpreter
 * unless one is chosen. Debugging runs uvicorn under debugpy.
 */
const fastapi: RunConfigTypeContribution = {
  id: "fastapi",
  label: "FastAPI",
  icon: "file-python",
  description: "Serve a FastAPI application with uvicorn",
  defaults: { app: "app", options: "--reload" },
  debugAdapter: "debugpy",
  fields: [
    interpreterField,
    {
      key: "file",
      label: "Application file",
      mono: true,
      required: true,
      placeholder: "main.py",
      hint: "Relative to the working directory",
      validate: (v) => (/^[^\s/\\][^\s]*\.py$/.test(v.trim()) ? null : "A .py file relative to the working directory"),
    },
    {
      key: "app",
      label: "Application name",
      mono: true,
      required: true,
      placeholder: "app",
      hint: "The FastAPI() object in that file",
      validate: (v) => (IDENTIFIER.test(v.trim()) ? null : "Not a Python name"),
    },
    { key: "options", label: "Uvicorn options", mono: true, placeholder: "e.g. --reload --port 8000" },
  ],
  commandLine(p) {
    const { command, runner } = interpreterLine(p.interpreter);
    const target = `${appModule(p.file ?? "")}:${p.app?.trim() || "app"}`;
    return { command, args: [...runner, "-m", "uvicorn", target, ...splitPython(p.options)] };
  },
  paramsFrom(c) {
    if (c.kind !== "fastapi") return null;
    const split = splitInterpreter(c);
    if (!split) return null;
    const [m, uvicorn, target, ...options] = split.args;
    const [module, app] = target?.split(":") ?? [];
    if (m !== "-m" || uvicorn !== "uvicorn" || !module || !app || !IDENTIFIER.test(app)) return null;
    return {
      interpreter: split.interpreter,
      file: `${module.split(".").join("/")}.py`,
      app,
      options: formatArgs(options),
    };
  },
};

/** `--opt` once among `options`, and the options without it. */
function takeFlag(options: string[], flag: string): [boolean, string[]] {
  const i = options.indexOf(flag);
  return i < 0 ? [false, options] : [true, [...options.slice(0, i), ...options.slice(i + 1)]];
}

/**
 * Flask (PyCharm's Flask Server): `python -m flask --app app.py run --debug` with the project
 * interpreter unless one is chosen; the app is a file or `package.module:create_app()`.
 */
const flask: RunConfigTypeContribution = {
  id: "flask",
  label: "Flask",
  icon: "file-python",
  description: "Serve a Flask application",
  defaults: { app: "app.py", debug: "true" },
  debugAdapter: "debugpy",
  fields: [
    interpreterField,
    {
      key: "app",
      label: "Application",
      mono: true,
      required: true,
      placeholder: "app.py",
      hint: "A file or module, optionally with the app: e.g. app.py or package.app:create_app()",
    },
    {
      key: "debug",
      label: "Debug mode",
      control: "checkbox",
      hint: "Reloads on changes and shows the debugger page on errors",
    },
    { key: "options", label: "Additional options", mono: true, placeholder: "e.g. --port 5000 --host 0.0.0.0" },
  ],
  commandLine(p) {
    const { command, runner } = interpreterLine(p.interpreter);
    const debug = p.debug === "true" ? ["--debug"] : [];
    return {
      command,
      args: [...runner, "-m", "flask", "--app", p.app?.trim() ?? "", "run", ...debug, ...splitPython(p.options)],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "flask") return null;
    const split = splitInterpreter(c);
    if (!split) return null;
    const [m, flask, appFlag, app, run, ...rest] = split.args;
    if (m !== "-m" || flask !== "flask" || appFlag !== "--app" || !app || run !== "run") return null;
    const [debug, options] = takeFlag(rest, "--debug");
    // Only a leading --debug reads back the same.
    if (debug && rest[0] !== "--debug") return null;
    return { interpreter: split.interpreter, app, debug: debug ? "true" : "", options: formatArgs(options) };
  },
};

/** `runserver`'s address argument: `8000`, `0.0.0.0:8000`, `[::]:8000`. */
const ADDRESS = /^(?:(.+):)?(\d+)$/;

/**
 * Django Server (PyCharm's): `python manage.py runserver host:port` with the project
 * interpreter unless one is chosen.
 */
const django: RunConfigTypeContribution = {
  id: "django",
  label: "Django Server",
  icon: "file-python",
  description: "Run a Django project's development server",
  defaults: { manage: "manage.py" },
  debugAdapter: "debugpy",
  fields: [
    interpreterField,
    { key: "manage", label: "manage.py", mono: true, required: true, placeholder: "manage.py" },
    { key: "host", label: "Host", mono: true, placeholder: "127.0.0.1" },
    {
      key: "port",
      label: "Port",
      mono: true,
      placeholder: "8000",
      validate: (v) => (/^\d+$/.test(v.trim()) ? null : "Port must be a number"),
    },
    { key: "options", label: "Additional options", mono: true, placeholder: "e.g. --noreload" },
  ],
  commandLine(p) {
    const { command, runner } = interpreterLine(p.interpreter);
    const host = p.host?.trim() ?? "";
    const port = p.port?.trim() || (host ? "8000" : "");
    const address = host ? [`${host}:${port}`] : port ? [port] : [];
    return {
      command,
      args: [...runner, p.manage?.trim() || "manage.py", "runserver", ...address, ...splitPython(p.options)],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "django") return null;
    const split = splitInterpreter(c);
    if (!split) return null;
    const [manage, runserver, ...rest] = split.args;
    if (!manage?.endsWith("manage.py") || runserver !== "runserver") return null;
    const address = rest[0] ? ADDRESS.exec(rest[0]) : null;
    return {
      interpreter: split.interpreter,
      manage,
      host: address?.[1] ?? "",
      port: address ? address[2]! : "",
      options: formatArgs(address ? rest.slice(1) : rest),
    };
  },
};

export const BUILTIN_TYPES: readonly RunConfigTypeContribution[] = [
  shell,
  program,
  npm,
  gradle,
  maven,
  godot,
  python,
  fastapi,
  flask,
  django,
  pytest,
  dotnetProjectType,
  dotnetTestType,
  goBuildType,
  goTestType,
  applicationType,
  springBootType,
  tomcatType,
  compound,
];

export function registerBuiltinTypes(): () => void {
  const disposers = BUILTIN_TYPES.map(registerRunConfigType);
  return () => disposers.forEach((d) => d());
}

export function typeFor(kind: string): RunConfigTypeContribution | undefined {
  return useRunConfigTypes.getState().types.get(kind);
}

/** Only Debug applies to `c` (Remote JVM Debug, Go Remote…): it attaches and launches no process. */
export const isDebugOnly = (c: Pick<RunConfig, "kind">, type = typeFor(c.kind)) => !!type?.debugOnly;

/**
 * The params the type form edits for `config`: its own, else derived from its command
 * line; null when the type can't reproduce that command line (edited as a plain command).
 */
export function formParams(config: RunConfig, type = typeFor(config.kind)): Record<string, string> | null {
  if (!type) return null;
  if (config.params && Object.keys(config.params).length && (type.id !== "go" || config.params.goKind))
    return { ...config.params };
  if (type.id === COMPOUND) return {};
  const derived = type.paramsFrom?.(config);
  if (!derived) return null;
  // Only when the form reproduces exactly what runs today.
  const line = type.commandLine(derived);
  if (!line) return null;
  if (type.id === "go") return derived;
  const sameCwd = !type.ownsWorkingDirectory || (line.cwd ?? null) === (config.cwd ?? null);
  return line.command === config.command && formatArgs(line.args) === formatArgs(config.args) && sameCwd
    ? derived
    : null;
}

/** `config` with `params` and the command line (and stop command) they produce. */
export function withParams(config: RunConfig, params: Record<string, string>, type = typeFor(config.kind)): RunConfig {
  const line = type?.commandLine(params);
  const { stopCommand: _previous, ...rest } = config;
  if (!line) return { ...rest, params, command: "", args: [] };
  return {
    ...rest,
    ...(config.kind === "dotnet" && config.beforeLaunch === undefined
      ? { beforeLaunch: [{ kind: "dotnetBuild", target: "" }] }
      : {}),
    ...(config.kind === "dotnet-test" ? { isTest: true } : {}),
    params: params.goKind ? { ...params, programArgv: JSON.stringify(parseArgs(params.programArgs ?? "")) } : params,
    ...(config.kind === "go-test" && !config.id.startsWith("template:") ? { kind: "go" } : {}),
    ...(params.goKind ? { isTest: params.goKind === "test" } : {}),
    command: line.command,
    args: line.args,
    ...(isJvmApplication(config) && parseJavaArgs(config.args).mainClass !== parseJavaArgs(line.args).mainClass
      ? { module: undefined }
      : {}),
    ...(type?.ownsWorkingDirectory ? { cwd: line.cwd ?? null } : {}),
    ...(line.stop ? { stopCommand: line.stop } : {}),
  };
}

/** Whether "Emulate terminal in output console" applies to `config`. */
export function terminalApplies(config: RunConfig, type = typeFor(config.kind)): boolean {
  return config.kind !== COMPOUND && !config.isTest && type?.terminal !== false && !type?.debugOnly;
}

/** Required params that are empty and values the field rejects, by key. */
export function missingParams(config: RunConfig, type = typeFor(config.kind)): Record<string, string> {
  const out: Record<string, string> = {};
  const params = formParams(config, type);
  if (!type || !params) return out;
  for (const f of type.fields) {
    if (f.control === "output" || !(f.visible?.(params) ?? true)) continue;
    const value = params[f.key]?.trim() ?? "";
    if (f.required && !value) out[f.key] = `${f.label} is required`;
    else if (value && f.validate) {
      const error = f.validate(value, params);
      if (error) out[f.key] = error;
    }
  }
  return out;
}

/** Template keys copied onto a new configuration ("Edit configuration templates…"). */
const TEMPLATE_KEYS = [
  "env",
  "cwd",
  "isTest",
  "debugAdapter",
  "allowParallel",
  "includeSystemEnv",
  "envFiles",
  "stdinFile",
  "outputFile",
  "beforeLaunch",
  "showOnStdout",
  "showOnStderr",
  "openToolWindow",
  "focusToolWindow",
  "emulateTerminal",
  "target",
] as const satisfies ReadonlyArray<keyof RunConfig>;

export const templateId = (kind: string) => `template:${kind}`;

/** An empty template for `type` (what a new configuration gets without one). */
export function blankTemplate(type: RunConfigTypeContribution): RunConfig {
  return withParams(
    {
      id: templateId(type.id),
      name: type.label,
      kind: type.id,
      command: "",
      args: [],
      cwd: null,
      env: {},
      detected: false,
      isTest: false,
      debugAdapter: type.debugAdapter ?? null,
    },
    newConfigDefaults(type),
    type,
  );
}

function newConfigDefaults(type: RunConfigTypeContribution): Record<string, string> {
  const defaults = { ...type.defaults };
  if (type.id === "gradle" && useProject.getState().settings?.languages?.java?.gradle?.distribution === "local") {
    defaults.wrapper = "false";
  }
  return defaults;
}

/** A new configuration of `type`, with the type's defaults and then its template applied. */
export function newConfigOfType(
  type: RunConfigTypeContribution,
  configs: readonly RunConfig[],
  template?: RunConfig | null,
  folder?: string | null,
): RunConfig {
  const base: RunConfig = {
    id: uid(),
    name: uniqueName("Unnamed", configs),
    kind: type.id,
    command: "",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
    local: true,
    ...(folder ? { folder } : {}),
  };
  const copied: Partial<RunConfig> = {};
  if (template) {
    for (const key of TEMPLATE_KEYS) {
      const v = template[key];
      if (v !== undefined) (copied as Record<string, unknown>)[key] = structuredClone(v);
    }
  }
  const params = { ...newConfigDefaults(type), ...(template?.params ?? {}) };
  const next = withParams({ ...base, ...copied }, params, type);
  return type.debugAdapter ? { ...next, debugAdapter: type.debugAdapter } : next;
}
