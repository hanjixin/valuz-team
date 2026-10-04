/**
 * Executes server RPCs on this machine, under the owner's local policy.
 *
 * The server already checked the caller's permission; the host checks again
 * with rules the server cannot override: a member who is not this machine's
 * owner can only touch `shared_roots`, and can only run commands when the
 * owner turned `allow_exec` on.
 */
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { arch, hostname, platform } from "node:os";
import path from "node:path";
import { type RuntimeFactory, SessionOrchestrator, createRuntime, detectRuntimes } from "@agent-base/kernel";
import {
  type Actor,
  type DeviceInfo,
  type FsEntry,
  type HostFrame,
  MANAGED_CWD_PREFIX,
  RpcMethods,
  SERVER_URL_PLACEHOLDER,
  managedWorkspace,
  type RuntimeAvailability,
} from "@agent-base/protocol";
import { execa } from "execa";
import type { HostConfig } from "./config.ts";
import { DeviceLink, RpcError } from "./link.ts";
import { RemoteStore } from "./remote-store.ts";

export const HOST_VERSION = "0.1.0";
const MAX_EXEC_OUTPUT = 1_000_000;

/** Resolve symlinks on the deepest existing ancestor, so a link cannot escape a root. */
async function canonical(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export interface HostOptions {
  config: HostConfig;
  dataDir: string;
  runtimeFactory?: RuntimeFactory;
  log?: (line: string) => void;
}

export class Host {
  readonly link: DeviceLink;
  readonly orchestrator: SessionOrchestrator;
  private readonly store: RemoteStore;
  private runtimes: RuntimeAvailability[] = [];
  private readonly log: (line: string) => void;

  constructor(private readonly options: HostOptions) {
    this.log = options.log ?? (() => undefined);
    this.link = new DeviceLink(options.config.server_url, options.config.device_token, {
      hello: () => this.hello(),
      rpc: (method, params, actor) => this.rpc(method, params, actor),
      status: (state, detail) => this.log(`link ${state}${detail ? ` (${detail})` : ""}`),
    });
    this.store = new RemoteStore(this.link);
    this.orchestrator = new SessionOrchestrator(this.store, options.runtimeFactory ?? createRuntime, {
      dataDir: options.dataDir,
    });
  }

  get config(): HostConfig {
    return this.options.config;
  }

  async start(): Promise<void> {
    this.runtimes = await detectRuntimes();
    this.orchestrator.start();
    this.link.start();
  }

  async stop(): Promise<void> {
    await this.orchestrator.shutdown();
    await this.link.stop();
  }

  private info(): DeviceInfo {
    return {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      host_version: HOST_VERSION,
      runtimes: this.runtimes,
      shared_roots: this.config.shared_roots,
      allow_exec: this.config.allow_exec,
    };
  }

  private hello(): Extract<HostFrame, { t: "hello" }> {
    // Include sessions whose final state is still in the outbox, so the server
    // does not mistake a turn that finished while offline for one that died.
    const running = new Set([...this.orchestrator.activeSessions(), ...this.link.pendingSessionIds()]);
    return { t: "hello", v: 1, info: this.info(), running: [...running] };
  }

  private isOwner(actor: Actor): boolean {
    return actor.user_id === this.config.owner_user_id;
  }

  /** The canonical path, after checking a non-owner stays inside a shared root. */
  private async authorizePath(actor: Actor, target: string): Promise<string> {
    if (!path.isAbsolute(target)) throw new RpcError("bad_request", "paths must be absolute");
    const real = await canonical(target);
    if (this.isOwner(actor)) return real;
    for (const root of this.config.shared_roots) {
      const realRoot = await canonical(root);
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
    }
    throw new RpcError("forbidden", "this path is outside the folders the device owner has shared");
  }

  /**
   * Where a session runs. A managed workspace lives under the host's own data
   * directory and is created on demand; anything else is a folder on this
   * machine, subject to the owner's sharing policy, and must already exist.
   */
  private async sessionCwd(actor: Actor, cwd: string): Promise<string> {
    if (cwd.startsWith(MANAGED_CWD_PREFIX)) {
      const name = managedWorkspace(cwd);
      if (!name) throw new RpcError("bad_request", "malformed managed workspace");
      const dir = path.join(this.options.dataDir, "workspaces", name);
      await mkdir(dir, { recursive: true });
      return dir;
    }
    const real = await this.authorizePath(actor, cwd);
    const isDirectory = await stat(real).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDirectory) throw new RpcError("bad_request", `working directory does not exist on this device: ${cwd}`);
    return real;
  }

  private async rpc(method: string, raw: unknown, actor: Actor): Promise<unknown> {
    if (!(method in RpcMethods)) throw new RpcError("unknown_method", `unknown method ${method}`);
    const name = method as keyof typeof RpcMethods;
    const parsed = RpcMethods[name].safeParse(raw);
    if (!parsed.success) throw new RpcError("bad_request", parsed.error.issues[0]?.message ?? "invalid params");
    this.log(`rpc ${method} by ${actor.name || actor.user_id}`);

    switch (name) {
      case "session.run": {
        const p = parsed.data as ReturnType<(typeof RpcMethods)["session.run"]["parse"]>;
        const cwd = await this.sessionCwd(actor, p.session.cwd);
        // MCP servers hosted by the server itself are addressed through the URL this host links by.
        const server = this.config.server_url.replace(/\/+$/, "");
        const hosted = (config: (typeof p.session.mcp_servers)[number]) =>
          config.transport !== "stdio" && config.url.startsWith(SERVER_URL_PLACEHOLDER)
            ? { ...config, url: server + config.url.slice(SERVER_URL_PLACEHOLDER.length) }
            : config;
        const session = { ...p.session, cwd, mcp_servers: p.session.mcp_servers.map(hosted) };
        this.store.adopt(session);
        // Answer "accepted" now; the turn streams back over the link.
        void this.orchestrator
          .runTurn(session.user_id, session.id, p.user_message, {
            messageId: p.message_id,
            skillBundles: p.skill_bundles,
          })
          .catch((err: unknown) => {
            // The turn never started (e.g. raced with another): put the server row back.
            this.log(`turn failed to start: ${err instanceof Error ? err.message : String(err)}`);
            this.link.sendState({ t: "session.patch", session_id: session.id, patch: { status: "idle" } });
          });
        return { accepted: true };
      }
      case "session.interrupt": {
        const p = parsed.data as { session_id: string };
        return { interrupted: await this.orchestrator.interrupt(p.session_id) };
      }
      case "session.action": {
        const p = parsed.data as ReturnType<(typeof RpcMethods)["session.action"]["parse"]>;
        try {
          await this.orchestrator.submitAction(p.session_id, p.action);
        } catch {
          throw new RpcError("not_found", "that approval is no longer pending");
        }
        return { submitted: true };
      }
      case "session.close": {
        const p = parsed.data as { session_id: string };
        await this.orchestrator.cleanup(p.session_id);
        this.store.forget(p.session_id);
        return { closed: true };
      }
      case "fs.list": {
        const dir = await this.authorizePath(actor, (parsed.data as { path: string }).path);
        const entries: FsEntry[] = [];
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          const s = await stat(full).catch(() => null);
          entries.push({
            name: e.name,
            path: full,
            kind: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
            size: s?.size ?? 0,
            mtime_ms: s?.mtimeMs ?? 0,
          });
        }
        return { path: dir, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
      }
      case "fs.stat": {
        const target = await this.authorizePath(actor, (parsed.data as { path: string }).path);
        const s = await stat(target);
        return { path: target, kind: s.isDirectory() ? "dir" : "file", size: s.size, mtime_ms: s.mtimeMs };
      }
      case "fs.read": {
        const p = parsed.data as { path: string; max_bytes: number };
        const target = await this.authorizePath(actor, p.path);
        const s = await stat(target);
        if (s.size > p.max_bytes) throw new RpcError("too_large", `file is ${s.size} bytes; limit is ${p.max_bytes}`);
        const buf = await readFile(target);
        const text = !buf.includes(0);
        return {
          path: target,
          size: s.size,
          encoding: text ? "utf8" : "base64",
          content: buf.toString(text ? "utf8" : "base64"),
        };
      }
      case "fs.write": {
        const p = parsed.data as { path: string; content: string; encoding: "utf8" | "base64" };
        const target = await this.authorizePath(actor, p.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(p.content, p.encoding));
        return { path: target, size: (await stat(target)).size };
      }
      case "fs.mkdir": {
        const target = await this.authorizePath(actor, (parsed.data as { path: string }).path);
        await mkdir(target, { recursive: true });
        return { path: target };
      }
      case "exec.run": {
        const p = parsed.data as { command: string; cwd: string; timeout_ms: number };
        if (!this.isOwner(actor) && !this.config.allow_exec) {
          throw new RpcError("forbidden", "the device owner has not enabled remote command execution");
        }
        return this.exec(p.command, await this.authorizePath(actor, p.cwd), p.timeout_ms);
      }
      case "device.info":
        return this.info();
    }
  }

  private async exec(command: string, cwd: string, timeoutMs: number): Promise<unknown> {
    const result = await execa(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      all: true,
      reject: false,
      maxBuffer: MAX_EXEC_OUTPUT,
      stripFinalNewline: false,
    });
    return {
      exit_code: result.exitCode ?? null,
      // A command that could not even be started has no output of its own.
      output: result.all || (result.failed && result.exitCode === undefined ? result.shortMessage : ""),
      timed_out: result.timedOut,
      truncated: result.isMaxBuffer,
    };
  }
}
