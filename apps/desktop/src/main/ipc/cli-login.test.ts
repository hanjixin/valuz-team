import { describe, expect, it, vi } from "vitest";
import {
  detectCliPath,
  detectLoginState,
  getCliStatus,
  launchTerminalWithCommand,
  type CliLoginDeps,
  type ExecResult,
} from "./cli-login";

const HOME = "/home/user";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "" });
const fail = (msg = "exit 1") => Promise.reject(new Error(msg));

const makeDeps = (overrides: Partial<CliLoginDeps> = {}): CliLoginDeps => ({
  execFile: vi.fn(async () => ok("")),
  spawnDetached: vi.fn(),
  stat: vi.fn(async () => {
    throw new Error("ENOENT");
  }),
  homedir: () => HOME,
  platform: () => "darwin",
  // Default to "no bundled binary" so tests that don't care about the
  // fallback get deterministic nulls instead of hitting the real fs.
  // Tests that exercise the bundled path override this.
  resolveBundled: () => null,
  ...overrides,
});

/**
 * Build deps where `which`/`where` resolves the tool to a fake global path,
 * and the status command against that path returns `statusOut`.
 *
 * `detectLoginState` now resolves the binary first (global → bundled) and
 * only then runs the status command, so the mock has to answer both calls.
 */
const makeGlobalLoginDeps = (
  tool: "claude" | "codex",
  statusOut: ExecResult | (() => Promise<ExecResult>),
  plat = "darwin",
): CliLoginDeps => {
  const globalPath = `/usr/local/bin/${tool}`;
  const statusArgs = tool === "claude" ? ["auth", "status"] : ["login", "status"];
  const whichCmd = plat === "win32" ? "where" : "which";
  return makeDeps({
    platform: () => plat,
    execFile: vi.fn(async (file: string, args: string[]) => {
      if (file === whichCmd) return ok(`${globalPath}\n`);
      if (file === globalPath && JSON.stringify(args) === JSON.stringify(statusArgs)) {
        return typeof statusOut === "function" ? statusOut() : statusOut;
      }
      return ok("");
    }),
  });
};

describe("detectCliPath", () => {
  it("should return resolved path when `which` succeeds", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => ok("/opt/homebrew/bin/claude\n")),
    });
    const path = await detectCliPath("claude", deps);
    expect(path).toBe("/opt/homebrew/bin/claude");
  });

  it("should return null when `which` exits non-zero", async () => {
    const deps = makeDeps({ execFile: vi.fn(() => fail()) });
    const path = await detectCliPath("codex", deps);
    expect(path).toBeNull();
  });

  it("should return null when `which` outputs blank", async () => {
    const deps = makeDeps({ execFile: vi.fn(async () => ok("\n")) });
    const path = await detectCliPath("claude", deps);
    expect(path).toBeNull();
  });
});

describe("detectLoginState — codex", () => {
  it("should report logged_in when `codex login status` says 'Logged in using ChatGPT'", async () => {
    const deps = makeGlobalLoginDeps(
      "codex",
      ok("Logged in using ChatGPT (account: jane@acme.io)\n"),
    );
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_in");
  });

  it("should report logged_in when codex is authed with an API key (not a subscription)", async () => {
    const deps = makeGlobalLoginDeps(
      "codex",
      ok("Logged in using an API key - sk-***1234\n"),
    );
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_in");
  });

  it("should report logged_out when the marker is missing from output", async () => {
    const deps = makeGlobalLoginDeps(
      "codex",
      ok("Not logged in. Run `codex login`.\n"),
      "linux",
    );
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_out");
  });

  it("should report logged_out when `codex login status` exits non-zero", async () => {
    const deps = makeGlobalLoginDeps("codex", () => fail("status: not authenticated"), "linux");
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_out");
  });

  it("should accept marker text printed on stderr too", async () => {
    const deps = makeGlobalLoginDeps("codex", {
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
    });
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_in");
  });

  it("should report logged_out on win32 when codex status fails", async () => {
    const deps = makeGlobalLoginDeps("codex", () => fail("not found"), "win32");
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_out");
  });

  it("should not spawn a bare `codex` when no global install exists", async () => {
    // `which` fails (no global codex) → resolveCliBinary falls back to bundled,
    // which doesn't exist in the test env, so detectLoginState returns
    // logged_out WITHOUT ever executing a status command.
    const execFile = vi.fn(() => fail("not on PATH"));
    const deps = makeDeps({ platform: () => "linux", execFile });
    const state = await detectLoginState("codex", deps);
    expect(state).toBe("logged_out");
    // Only the `which` lookup should have run — no bare "codex" status call.
    expect(execFile).toHaveBeenCalledWith("which", ["codex"]);
    expect(execFile).not.toHaveBeenCalledWith("codex", ["login", "status"]);
  });
});

describe("detectLoginState — claude", () => {
  it('should require BOTH `loggedIn: true` and `authMethod: "claude.ai"` markers', async () => {
    const deps = makeGlobalLoginDeps(
      "claude",
      ok('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "account": "jane"\n}\n'),
    );
    const state = await detectLoginState("claude", deps);
    expect(state).toBe("logged_in");
  });

  it("should report logged_out when `loggedIn` is true but authMethod is not claude.ai", async () => {
    // e.g. an API-key-only login — we only count the OAuth/claude.ai path.
    const deps = makeGlobalLoginDeps(
      "claude",
      ok('{\n  "loggedIn": true,\n  "authMethod": "api_key"\n}'),
    );
    const state = await detectLoginState("claude", deps);
    expect(state).toBe("logged_out");
  });

  it("should report logged_out when `loggedIn` is false even with claude.ai authMethod", async () => {
    const deps = makeGlobalLoginDeps(
      "claude",
      ok('{\n  "loggedIn": false,\n  "authMethod": "claude.ai"\n}'),
    );
    const state = await detectLoginState("claude", deps);
    expect(state).toBe("logged_out");
  });

  it("should report logged_out when `claude auth status` exits non-zero", async () => {
    const deps = makeGlobalLoginDeps("claude", () => fail("not authenticated"), "linux");
    const state = await detectLoginState("claude", deps);
    expect(state).toBe("logged_out");
  });

  it("should accept marker text printed on stderr too", async () => {
    const deps = makeGlobalLoginDeps("claude", {
      stdout: "",
      stderr: '"loggedIn": true,\n"authMethod": "claude.ai",\n',
    }, "linux");
    const state = await detectLoginState("claude", deps);
    expect(state).toBe("logged_in");
  });

  it("should not spawn a bare `claude` when no global install exists", async () => {
    // `which` fails (no global claude) → resolveCliBinary falls back to bundled,
    // which doesn't exist in the test env, so detectLoginState returns
    // logged_out WITHOUT ever executing a status command.
    const execFile = vi.fn(() => fail("not on PATH"));
    const deps = makeDeps({ platform: () => "linux", execFile });
    const state = await detectLoginState("claude", deps);
    expect(state).toBe("logged_out");
    expect(execFile).toHaveBeenCalledWith("which", ["claude"]);
    expect(execFile).not.toHaveBeenCalledWith("claude", ["auth", "status"]);
  });
});

describe("getCliStatus", () => {
  it("should combine cliPath + state for the happy path", async () => {
    const execFile = vi.fn(async (file: string) => {
      if (file === "which") return ok("/usr/local/bin/claude\n");
      if (file === "/usr/local/bin/claude")
        return ok(
          '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "account": "jane"\n}',
        );
      return ok("");
    });
    const deps = makeDeps({ platform: () => "darwin", execFile });
    const status = await getCliStatus("claude", deps);
    expect(status).toEqual({
      installed: true,
      state: "logged_in",
      cliPath: "/usr/local/bin/claude",
    });
  });

  it("should report installed:false when CLI is missing from PATH", async () => {
    const deps = makeDeps({
      platform: () => "darwin",
      execFile: vi.fn(() => fail()),
    });
    const status = await getCliStatus("codex", deps);
    expect(status.installed).toBe(false);
    expect(status.cliPath).toBeNull();
  });
});

describe("launchTerminalWithCommand — darwin", () => {
  it("should invoke osascript with Terminal.app and the login command", async () => {
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "which" && args[0] === "claude") return ok("/usr/local/bin/claude\n");
      return ok("");
    });
    const deps = makeDeps({ platform: () => "darwin", execFile });
    const result = await launchTerminalWithCommand("claude", deps);
    expect(result).toEqual({ launched: true });
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      'tell application "Terminal" to do script "/usr/local/bin/claude /login"',
    ]);
  });

  it("should propagate osascript failure as launched:false", async () => {
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "which" && args[0] === "codex") return ok("/usr/local/bin/codex\n");
      return fail("not allowed");
    });
    const deps = makeDeps({ platform: () => "darwin", execFile });
    const result = await launchTerminalWithCommand("codex", deps);
    expect(result.launched).toBe(false);
    expect(result.error).toBe("not allowed");
  });

  it("should send `login` (subcommand) for the codex tool", async () => {
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "which" && args[0] === "codex") return ok("/usr/local/bin/codex\n");
      return ok("");
    });
    const deps = makeDeps({ platform: () => "darwin", execFile });
    await launchTerminalWithCommand("codex", deps);
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      'tell application "Terminal" to do script "/usr/local/bin/codex login"',
    ]);
  });
});

describe("launchTerminalWithCommand — linux", () => {
  it("should spawn the first terminal found via `which`", async () => {
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const arg = args[0];
      if (arg === "x-terminal-emulator") return ok("/usr/bin/x-terminal-emulator\n");
      if (arg === "claude") return ok("/usr/local/bin/claude\n");
      return fail();
    });
    const deps = makeDeps({
      platform: () => "linux",
      execFile,
      spawnDetached,
    });
    const result = await launchTerminalWithCommand("claude", deps);
    expect(result).toEqual({ launched: true });
    expect(spawnDetached).toHaveBeenCalledWith("/usr/bin/x-terminal-emulator", [
      "-e",
      "bash",
      "-c",
      "/usr/local/bin/claude /login; exec bash",
    ]);
  });

  it("should run `login` inside the spawned terminal for the codex tool", async () => {
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const arg = args[0];
      if (arg === "x-terminal-emulator") return ok("/usr/bin/x-terminal-emulator\n");
      if (arg === "codex") return ok("/usr/local/bin/codex\n");
      return fail();
    });
    const deps = makeDeps({
      platform: () => "linux",
      execFile,
      spawnDetached,
    });
    await launchTerminalWithCommand("codex", deps);
    expect(spawnDetached).toHaveBeenCalledWith("/usr/bin/x-terminal-emulator", [
      "-e",
      "bash",
      "-c",
      "/usr/local/bin/codex login; exec bash",
    ]);
  });

  it("should report no_terminal when none of the known terminals are on PATH", async () => {
    // Binary resolves (global codex) so we reach the terminal lookup, which
    // finds nothing → no_terminal. Without the global path we'd exit early
    // with binary_not_found and never test the terminal-missing branch.
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "codex") return ok("/usr/local/bin/codex\n");
      return fail();
    });
    const deps = makeDeps({
      platform: () => "linux",
      execFile,
    });
    const result = await launchTerminalWithCommand("codex", deps);
    expect(result).toEqual({ launched: false, error: "no_terminal" });
  });
});

describe("launchTerminalWithCommand — win32", () => {
  it("should launch via wt.exe when Windows Terminal is available", async () => {
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "where" && args[0] === "wt.exe") return ok("C:\\Windows\\wt.exe\n");
      if (file === "where" && args[0] === "claude.exe") return ok("C:\\Users\\test\\claude.exe\n");
      return ok("");
    });
    const deps = makeDeps({
      platform: () => "win32",
      execFile,
      spawnDetached,
    });
    const result = await launchTerminalWithCommand("claude", deps);
    expect(result).toEqual({ launched: true });
    expect(spawnDetached).toHaveBeenCalledWith("cmd.exe", [
      "/c",
      "start",
      '""',
      "wt.exe",
      "new-tab",
      "--",
      "cmd.exe",
      "/K",
      "C:\\Users\\test\\claude.exe /login",
    ]);
  });

  it("should fall back to cmd.exe when Windows Terminal is not available", async () => {
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "where" && args[0] === "wt.exe") return fail();
      if (file === "where" && args[0] === "codex.exe") return ok("C:\\Users\\test\\codex.exe\n");
      return ok("");
    });
    const deps = makeDeps({
      platform: () => "win32",
      execFile,
      spawnDetached,
    });
    const result = await launchTerminalWithCommand("codex", deps);
    expect(result).toEqual({ launched: true });
    expect(spawnDetached).toHaveBeenCalledWith("cmd.exe", [
      "/c",
      "start",
      '""',
      "cmd.exe",
      "/K",
      "C:\\Users\\test\\codex.exe login",
    ]);
  });
});

describe("launchTerminalWithCommand — bundled fallback", () => {
  // Regression: when there's no global install, the terminal MUST be given
  // the bundled binary's absolute path. A bare `claude`/`codex` goes through
  // PATH and silently ENOENTs on machines with no global install, so the
  // user clicks Login, the status check says installed:true (it found the
  // bundled binary), and then the terminal opens and immediately fails.
  //
  // The bundled paths below mirror what `resolveBundledClaude` /
  // `resolveBundledCodex` actually return in a packaged build:
  //   <resourcesPath>/libexec/_internal/claude_agent_sdk/_bundled/claude[.exe]
  //   <resourcesPath>/libexec/_internal/codex_cli_bin/bin/codex[.exe]
  const WIN_RESOURCES =
    "C:\\Users\\test\\AppData\\Local\\Programs\\Valuz\\resources";
  const WIN_BUNDLED_CLAUDE = `${WIN_RESOURCES}\\libexec\\_internal\\claude_agent_sdk\\_bundled\\claude.exe`;
  const MAC_BUNDLED_CLAUDE =
    "/Applications/Valuz.app/Contents/Resources/libexec/_internal/claude_agent_sdk/_bundled/claude";
  const LINUX_BUNDLED_CODEX =
    "/opt/Valuz/resources/libexec/_internal/codex_cli_bin/bin/codex";

  it("win32: uses the bundled claude.exe when no global install exists", async () => {
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "where" && args[0] === "wt.exe") return ok("C:\\Windows\\wt.exe\n");
      // `where claude.exe` returns blank — no global install
      return ok("");
    });
    const deps = makeDeps({
      platform: () => "win32",
      execFile,
      spawnDetached,
      resolveBundled: () => WIN_BUNDLED_CLAUDE,
    });
    const result = await launchTerminalWithCommand("claude", deps);
    expect(result).toEqual({ launched: true });
    expect(spawnDetached).toHaveBeenCalledWith("cmd.exe", [
      "/c",
      "start",
      '""',
      "wt.exe",
      "new-tab",
      "--",
      "cmd.exe",
      "/K",
      `${WIN_BUNDLED_CLAUDE} /login`,
    ]);
  });

  it("win32: quotes the bundled path for a per-machine install under Program Files", async () => {
    // electron-builder's nsis installer defaults to per-user (%LOCALAPPDATA%,
    // no spaces), but a per-machine install lands under "C:\Program Files\..."
    // — the path then contains a space and cmd.exe /K needs it double-quoted.
    const programFilesCodex =
      "C:\\Program Files\\Valuz\\resources\\libexec\\_internal\\codex_cli_bin\\bin\\codex.exe";
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "where" && args[0] === "wt.exe") return ok("C:\\Windows\\wt.exe\n");
      return ok("");
    });
    const deps = makeDeps({
      platform: () => "win32",
      execFile,
      spawnDetached,
      resolveBundled: () => programFilesCodex,
    });
    await launchTerminalWithCommand("codex", deps);
    expect(spawnDetached).toHaveBeenCalledWith("cmd.exe", [
      "/c",
      "start",
      '""',
      "wt.exe",
      "new-tab",
      "--",
      "cmd.exe",
      "/K",
      `"${programFilesCodex}" login`,
    ]);
  });

  it("darwin: uses the bundled claude when no global install exists", async () => {
    const execFile = vi.fn(async (file: string) => {
      // `which claude` fails (no global install); osascript succeeds.
      if (file === "which") return fail("not on PATH");
      return ok("");
    });
    const deps = makeDeps({
      platform: () => "darwin",
      execFile,
      resolveBundled: () => MAC_BUNDLED_CLAUDE,
    });
    const result = await launchTerminalWithCommand("claude", deps);
    expect(result).toEqual({ launched: true });
    expect(execFile).toHaveBeenCalledWith("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script "${MAC_BUNDLED_CLAUDE} /login"`,
    ]);
  });

  it("linux: uses the bundled codex when no global install exists", async () => {
    const spawnDetached = vi.fn();
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      const arg = args[0];
      if (arg === "x-terminal-emulator") return ok("/usr/bin/x-terminal-emulator\n");
      // `which codex` fails — no global install
      return fail();
    });
    const deps = makeDeps({
      platform: () => "linux",
      execFile,
      spawnDetached,
      resolveBundled: () => LINUX_BUNDLED_CODEX,
    });
    const result = await launchTerminalWithCommand("codex", deps);
    expect(result).toEqual({ launched: true });
    expect(spawnDetached).toHaveBeenCalledWith("/usr/bin/x-terminal-emulator", [
      "-e",
      "bash",
      "-c",
      `${LINUX_BUNDLED_CODEX} login; exec bash`,
    ]);
  });

  it("returns binary_not_found when neither global nor bundled resolves", async () => {
    // `where` blank, resolveBundled defaults to null (makeDeps).
    const deps = makeDeps({
      platform: () => "win32",
      execFile: vi.fn(async () => ok("")),
    });
    const result = await launchTerminalWithCommand("claude", deps);
    expect(result).toEqual({ launched: false, error: "binary_not_found" });
  });
});

describe("bundled CLI fallback", () => {
  it("detectCliPath should fall back to bundled claude when which fails", async () => {
    // `which` fails AND makeDeps' default resolveBundled returns null →
    // detectCliPath reports null (no global, no bundled).
    const deps = makeDeps({ execFile: vi.fn(() => fail()) });
    const path = await detectCliPath("claude", deps);
    expect(path).toBeNull();
  });

  it("detectCliPath should fall back to bundled codex when which fails", async () => {
    const deps = makeDeps({ execFile: vi.fn(() => fail()) });
    const path = await detectCliPath("codex", deps);
    expect(path).toBeNull();
  });

  it("detectCliPath returns the bundled path when resolveBundled supplies one", async () => {
    const deps = makeDeps({
      execFile: vi.fn(() => fail()),
      resolveBundled: () => "/bundle/claude",
    });
    const path = await detectCliPath("claude", deps);
    expect(path).toBe("/bundle/claude");
  });
});
