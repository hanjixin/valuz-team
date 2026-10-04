import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ESM __dirname equivalent for dev-mode path resolution.
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

export type CliTool = "claude" | "codex";
export type LoginState = "logged_in" | "logged_out" | "unsupported";

export interface CliStatus {
  installed: boolean;
  state: LoginState;
  cliPath: string | null;
}

export interface LaunchResult {
  launched: boolean;
  error?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface StatLike {
  size: number;
  mode: number;
}

export interface CliLoginDeps {
  execFile: (file: string, args: string[]) => Promise<ExecResult>;
  spawnDetached: (file: string, args: string[]) => void;
  stat: (path: string) => Promise<StatLike>;
  homedir: () => string;
  platform: () => string;
  /**
   * Resolve a CLI binary bundled inside the backend's PyInstaller bundle.
   * Injected so tests can exercise the bundled-fallback path without the
   * real filesystem; ``defaultDeps`` wires it to the module-level resolver.
   */
  resolveBundled?: (tool: CliTool) => string | null;
}

export const defaultDeps: CliLoginDeps = {
  execFile: async (file, args) => {
    const { stdout, stderr } = await execFileAsync(file, args);
    return { stdout: String(stdout), stderr: String(stderr) };
  },
  spawnDetached: (file, args) => {
    // On Windows, `detached: true` translates to DETACHED_PROCESS, which
    // spawns console apps (cmd.exe) WITHOUT a console window — they run
    // invisibly. We skip it there; the caller wraps Windows launches in
    // `cmd /c start` so a new window appears and parent-detachment still
    // works. On Linux we keep detached so the terminal outlives Electron.
    const isWindows = platform() === "win32";
    const child = spawn(file, args, {
      detached: !isWindows,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    // spawn errors (ENOENT, EPERM) fire asynchronously — without a listener
    // they vanish and we'd silently report success. Log so a failed launch
    // is at least visible in `valuz logs`.
    child.on("error", (err) => {
      console.error(`[cli-login] spawn failed for ${file}:`, err);
    });
  },
  stat: async (path) => {
    const s = await stat(path);
    return { size: s.size, mode: s.mode };
  },
  homedir,
  platform,
  resolveBundled: (tool) => resolveBundled(tool),
};

// Strict markers we require in each CLI's status output before declaring a

/**
 * Resolve a CLI binary bundled inside the backend's PyInstaller bundle (prod)
 * or the dev venv. Both expose the same package layout under different roots:
 *
 *   Production (packaged, same root as sidecar.ts):
 *     Valuz.app/Contents/Resources/libexec/_internal/<…segments>
 *   Dev (the python3.X minor isn't pinned — it tracks whatever `uv` resolved
 *   for the venv, so we glob it):
 *     backend/.venv/lib/python3.X/site-packages/<…segments>
 *
 * ``segments`` is the path *inside* the bundle root — e.g.
 * ``["claude_agent_sdk", "_bundled", "claude"]`` or
 * ``["codex_cli_bin", "bin", "codex"]``.
 */
function resolveBundledBinary(segments: string[]): string | null {
  // Production: packaged Electron app. ``process.resourcesPath`` is an
  // Electron-only global — undefined under plain Node (e.g. vitest), where
  // ``join(undefined, …)`` would throw. Guard it so the function stays
  // callable off-Electron and the dev fallback below remains reachable.
  if (process.resourcesPath) {
    const bundled = join(
      process.resourcesPath,
      "libexec",
      "_internal",
      ...segments,
    );
    if (existsSync(bundled)) return bundled;
  }

  // Dev: walk up from dist-electron/ to the repo root, then into the backend
  // venv. dist-electron sits at frontend/apps/desktop/dist-electron, so the
  // repo root is exactly 4 levels up (desktop → apps → frontend → repo) — an
  // earlier 5th ".." overshot to the repo's parent and the fallback never
  // resolved. The Python minor version in the path (lib/python3.X/) isn't
  // pinned — it follows whatever interpreter `uv` resolved — so glob every
  // python3.* dir instead of hardcoding one (hardcoding 3.13 silently missed
  // a 3.12 venv, making the bundled binary read as "not installed").
  const venvLib = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "backend",
    ".venv",
    "lib",
  );
  let pyDirs: string[] = [];
  try {
    pyDirs = readdirSync(venvLib)
      .filter((d) => d.startsWith("python3."))
      .sort()
      .reverse(); // prefer the newest minor when several venvs coexist
  } catch {
    // venv lib dir absent (no dev venv) — nothing to glob
  }
  for (const py of pyDirs) {
    const candidate = join(venvLib, py, "site-packages", ...segments);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Bundled Claude CLI (shipped inside the ``claude_agent_sdk`` package):
 *   prod: …/libexec/_internal/claude_agent_sdk/_bundled/claude
 *   dev:  backend/.venv/lib/python3.X/site-packages/claude_agent_sdk/_bundled/claude
 */
function resolveBundledClaude(): string | null {
  const binaryName = platform() === "win32" ? "claude.exe" : "claude";
  return resolveBundledBinary(["claude_agent_sdk", "_bundled", binaryName]);
}

/**
 * Bundled Codex CLI (shipped inside the ``codex_cli_bin`` package):
 *   prod: …/libexec/_internal/codex_cli_bin/bin/codex
 *   dev:  backend/.venv/lib/python3.X/site-packages/codex_cli_bin/bin/codex
 */
function resolveBundledCodex(): string | null {
  const binaryName = platform() === "win32" ? "codex.exe" : "codex";
  return resolveBundledBinary(["codex_cli_bin", "bin", binaryName]);
}

function resolveBundled(tool: CliTool): string | null {
  return tool === "claude" ? resolveBundledClaude() : resolveBundledCodex();
}

// Strict markers we require in each CLI's status output before declaring a
// successful login. The previous heuristics (keychain entry exists / file
// non-empty) returned true for stale or partially provisioned credentials
// — only the CLIs themselves know whether the auth is actually usable, so
// we shell out and parse their authoritative answer.
//
// claude — ``claude auth status`` JSON-ish: must contain BOTH markers.
// codex  — ``codex login status`` plaintext: accept ANY login method, not
//          just the ChatGPT subscription. The CLI prints one of
//          "Logged in using ChatGPT" / "Logged in using an API key - …" /
//          "Logged in using access token" when authed, and "Not logged in"
//          otherwise — so the shared "Logged in using" prefix is the marker
//          (it can't match "Not logged in"). Keying only on ChatGPT made an
//          API-key codex read as logged_out even though the codex runtime
//          runs fine off that key.
const CLAUDE_STATUS_MARKERS = [
  '"loggedIn": true,',
  '"authMethod": "claude.ai",',
];
const CODEX_STATUS_MARKER = "Logged in using";

const LINUX_TERMINALS = [
  "x-terminal-emulator",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "xterm",
] as const;

// Some CLIs print the status on stderr (claude does, codex split). Search
// both streams so the strict-marker check works regardless.
const allOutput = (r: ExecResult): string => `${r.stdout}\n${r.stderr}`;

/**
 * Resolve which binary to actually invoke for a CLI tool.
 *
 * Order:
 *   1. Global install (``which``/``where``) — if the user has it on PATH, use it.
 *   2. Bundled binary (PyInstaller bundle / dev venv) — fallback when there is
 *      no global install. We must NOT spawn a bare ``claude``/``codex`` command
 *      when the user hasn't installed one globally: that goes through PATH,
 *      hits some unrelated stub or just ENOENTs, and the real bundled binary
 *      never gets a chance. Resolve the path first, then execute that path.
 */
const resolveCliBinary = async (
  tool: CliTool,
  deps: CliLoginDeps = defaultDeps,
): Promise<string | null> => {
  const plat = deps.platform();
  const whichCmd = plat === "win32" ? "where" : "which";
  const toolName = plat === "win32" ? `${tool}.exe` : tool;

  try {
    const { stdout } = await deps.execFile(whichCmd, [toolName]);
    // `where` returns multiple matches, one per line
    const path = stdout.trim().split("\n")[0].trim();
    if (path.length > 0) return path;
  } catch {
    // which/where failed — fall through to bundled
  }

  return deps.resolveBundled ? deps.resolveBundled(tool) : null;
};

export const detectCliPath = async (
  tool: CliTool,
  deps: CliLoginDeps = defaultDeps,
): Promise<string | null> => resolveCliBinary(tool, deps);

export const detectLoginState = async (
  tool: CliTool,
  deps: CliLoginDeps = defaultDeps,
): Promise<LoginState> => {
  // Resolve the exact binary to invoke — global if installed, bundled
  // otherwise — so we never spawn a bare ``claude``/``codex`` that relies on
  // PATH when the user hasn't installed one globally.
  const binary = await resolveCliBinary(tool, deps);
  if (!binary) return "logged_out";

  if (tool === "claude") {
    try {
      const result = await deps.execFile(binary, ["auth", "status"]);
      const out = allOutput(result);
      const allPresent = CLAUDE_STATUS_MARKERS.every((m) => out.includes(m));
      return allPresent ? "logged_in" : "logged_out";
    } catch {
      return "logged_out";
    }
  }

  // tool === 'codex'
  try {
    const result = await deps.execFile(binary, ["login", "status"]);
    const out = allOutput(result);
    return out.includes(CODEX_STATUS_MARKER) ? "logged_in" : "logged_out";
  } catch {
    return "logged_out";
  }
};

export const getCliStatus = async (
  tool: CliTool,
  deps: CliLoginDeps = defaultDeps,
): Promise<CliStatus> => {
  const cliPath = await detectCliPath(tool, deps);
  const state = await detectLoginState(tool, deps);
  return { installed: cliPath !== null, state, cliPath };
};

const findLinuxTerminal = async (
  deps: CliLoginDeps,
): Promise<string | null> => {
  for (const term of LINUX_TERMINALS) {
    try {
      const { stdout } = await deps.execFile("which", [term]);
      const path = stdout.trim();
      if (path.length > 0) return path;
    } catch {
      // try next
    }
  }
  return null;
};

// Each CLI surfaces its login flow through a different invocation:
//   - claude uses an in-REPL slash command (``claude /login``)
//   - codex uses a regular subcommand (``codex login``)
// Only the args live here — the binary path is resolved per-launch (global →
// bundled) so the terminal never depends on PATH. Splicing the path in at
// call time is what makes the bundled binary reachable on machines with no
// global install.
const LOGIN_ARGS: Record<CliTool, string[]> = {
  claude: ["/login"],
  codex: ["login"],
};

/**
 * Build the login command using an absolute binary path. The terminal must
 * not rely on PATH: a bare ``claude``/``codex`` goes through PATH and
 * silently ENOENTs when the user hasn't installed one globally, leaving the
 * bundled binary unused. Quote the path only when it contains spaces —
 * unnecessary quotes can confuse cmd's quirky parser, and typical install
 * paths (``/usr/local/bin/claude``, ``%LOCALAPPDATA%\Programs\Valuz\…``)
 * have none.
 */
const buildLoginCommand = (
  plat: string,
  binary: string,
  args: string[],
): string => {
  const argStr = args.join(" ");
  const needsQuote = /\s/.test(binary);
  if (plat === "win32") {
    const bin = needsQuote ? `"${binary}"` : binary;
    return `${bin} ${argStr}`;
  }
  const bin = needsQuote ? `'${binary}'` : binary;
  return `${bin} ${argStr}`;
};

export const launchTerminalWithCommand = async (
  tool: CliTool,
  deps: CliLoginDeps = defaultDeps,
): Promise<LaunchResult> => {
  const plat = deps.platform();

  // Resolve the binary the SAME way status detection does — global first,
  // bundled otherwise. Without this the terminal receives a bare
  // ``claude``/``codex`` that goes through PATH; on machines with no global
  // install that silently ENOENTs and the bundled binary never runs, even
  // though ``getCliStatus`` just reported ``installed: true`` from the same
  // bundled path.
  const binary = await resolveCliBinary(tool, deps);
  if (!binary) {
    return { launched: false, error: "binary_not_found" };
  }
  const command = buildLoginCommand(plat, binary, LOGIN_ARGS[tool]);

  if (plat === "darwin") {
    try {
      await deps.execFile("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${command}"`,
      ]);
      return { launched: true };
    } catch (err) {
      return {
        launched: false,
        error: err instanceof Error ? err.message : "osascript failed",
      };
    }
  }

  if (plat === "linux") {
    const term = await findLinuxTerminal(deps);
    if (!term) {
      return { launched: false, error: "no_terminal" };
    }
    try {
      deps.spawnDetached(term, ["-e", "bash", "-c", `${command}; exec bash`]);
      return { launched: true };
    } catch (err) {
      return {
        launched: false,
        error: err instanceof Error ? err.message : "spawn failed",
      };
    }
  }

  if (plat === "win32") {
    // Wrap launches in `cmd /c start "" ...`. Two reasons:
    //   1. `start` opens a NEW console window — without it, a console app
    //      spawned from Electron (which has no console of its own) either
    //      attaches nowhere or, with `detached: true`, is created with
    //      DETACHED_PROCESS = no window at all (the previous bug: the
    //      terminal never appeared).
    //   2. `start` goes through ShellExecute, which resolves Microsoft Store
    //      App Execution Aliases (wt.exe is one — a zero-byte reparse point
    //      under %LOCALAPPDATA%\Microsoft\WindowsApps). Plain Node spawn
    //      (CreateProcessW) can't launch those, so wt silently failed and,
    //      because spawn doesn't throw, the cmd.exe fallback never ran.
    const hasWt = await deps
      .execFile("where", ["wt.exe"])
      .then(() => true)
      .catch(() => false);
    const launchArgs = hasWt
      ? ["/c", "start", '""', "wt.exe", "new-tab", "--", "cmd.exe", "/K", command]
      : ["/c", "start", '""', "cmd.exe", "/K", command];
    try {
      deps.spawnDetached("cmd.exe", launchArgs);
      return { launched: true };
    } catch (err) {
      return {
        launched: false,
        error: err instanceof Error ? err.message : "Failed to launch terminal",
      };
    }
  }

  return { launched: false, error: "unsupported_platform" };
};
