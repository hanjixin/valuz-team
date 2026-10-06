/**
 * agent-base: the desktop as a member of a team.
 *
 * There is no local backend any more. The app talks to the team's server, and
 * this process keeps two things running for it:
 *
 * - `agent-server`, which is now a small reverse proxy on the port the
 *   renderer has always used (it was built against a backend on localhost), so
 *   the pages need not know where the server is;
 * - the host (`agent-base-host`), which links this computer to the server and
 *   runs sessions here, once the signed-in member has linked it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import httpProxy from "http-proxy";
import { PERSONAL_PORTS, type ServiceInfo, type ServiceStatusType } from "@valuz/shared";
import { DescriptorRegistry, personalDescriptors } from "./descriptors";
import type { DesktopServiceManager } from "./mod";
import { recordSidecarLine } from "./system-logs";

const SERVER = "agent-server";
const HEALTH_TIMEOUT_MS = 20_000;
const HOST_RESTART_MS = 3000;

export type HostState = "unlinked" | "starting" | "online" | "offline" | "rejected" | "stopped";

/** Where this desktop stands with its team server: what the connection screens show. */
export interface TeamConnection {
  server_url: string;
  device_id: string | null;
  device_name: string;
  host: HostState;
}

interface HostConfig {
  server_url: string;
  device_id: string;
  device_token: string;
  owner_user_id: string;
  shared_roots: string[];
  allow_exec: boolean;
}

export interface TeamServiceManager extends DesktopServiceManager {
  getConnection(): TeamConnection;
  /** Point the desktop at a server (checked to be one). Restarts the services. */
  setServerUrl(url: string): Promise<TeamConnection>;
  /** Register this computer as the signed-in member's device and start the host. */
  linkDevice(accessToken: string, orgId?: string): Promise<TeamConnection>;
  unlinkDevice(): Promise<TeamConnection>;
  /**
   * Someone signed in, or moved to another of their organizations. A computer is
   * a device in one organization for one member, so each account-in-an-organization
   * has a link of its own here: the one it had is taken up again, and — unless
   * `link` is false — one is made the first time.
   */
  useAccount(account: { accessToken: string; orgId: string; userId: string; link?: boolean }): Promise<TeamConnection>;
  /** Nobody is signed in: the host stops. The links are kept for whoever signs in again. */
  signOut(): Promise<TeamConnection>;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

const normalize = (url: string): string => url.trim().replace(/\/+$/, "");

export function createTeamServiceManager(
  userDataDir: string,
  options: {
    egressManager?: {
      getDiagnostics(): ReturnType<DesktopServiceManager["getEgressDiagnostics"]>;
      getSnapshots(): ReturnType<DesktopServiceManager["getEgressSnapshots"]>;
      getMode(): ReturnType<DesktopServiceManager["getEgressMode"]>;
      getStatus(): ReturnType<DesktopServiceManager["getEgressStatus"]>;
      getRuntimePhases(): ReturnType<DesktopServiceManager["getEgressRuntimePhases"]>;
      setMode(mode: ReturnType<DesktopServiceManager["getEgressMode"]>): Promise<unknown>;
    };
    onChange?: (services: ServiceInfo[]) => void;
    /** The host's entry point; the Electron binary runs it as Node. */
    hostCli?: string;
    port?: number;
  } = {},
): TeamServiceManager {
  const descriptors = new DescriptorRegistry(personalDescriptors());
  const port = options.port ?? PERSONAL_PORTS.AGENT_SERVER;
  const settingsFile = path.join(userDataDir, "desktop.json");
  const hostHome = path.join(userDataDir, "host");
  const hostConfigFile = path.join(hostHome, "host.json");
  /** Every link this computer has, by `<organization>:<member>`; `host.json` is the one in use. */
  const linksFile = path.join(hostHome, "links.json");
  const controlToken = crypto.randomBytes(24).toString("hex");
  const logs: string[] = [];

  let serverUrl = normalize(
    process.env["AGENT_BASE_SERVER_URL"] ?? readJson<{ server_url?: string }>(settingsFile)?.server_url ?? "",
  );
  let status: ServiceStatusType = "stopped";
  let detail = "";
  let proxy: Server | null = null;
  let host: ChildProcess | null = null;
  let hostState: HostState = "stopped";
  let restart: NodeJS.Timeout | null = null;
  let stopping = false;
  /** Who is signed in, and in which of their organizations. */
  let account: { orgId: string; userId: string } | null = null;

  type Links = Record<string, HostConfig>;
  const keyOf = (who: { orgId: string; userId: string }): string => `${who.orgId}:${who.userId}`;
  const readLinks = (): Links => readJson<Links>(linksFile) ?? {};
  /** The files hold device tokens: readable by their owner only. */
  const writeSecret = (file: string, value: unknown): void => {
    mkdirSync(hostHome, { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  };
  const forgetLink = (deviceId: string): void =>
    writeSecret(linksFile, Object.fromEntries(Object.entries(readLinks()).filter(([, link]) => link.device_id !== deviceId)));

  /** Register this computer with the server as a device of the caller, in the given organization. */
  async function register(accessToken: string, orgId?: string): Promise<HostConfig> {
    if (!serverUrl) throw new Error("server_url_missing");
    const res = await fetch(`${serverUrl}/v1/devices`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...(orgId ? { "x-org-id": orgId } : {}),
      },
      body: JSON.stringify({ name: hostname() }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      token?: string;
      owner_id?: string;
      message?: string;
    };
    if (!res.ok || !body.id || !body.token || !body.owner_id)
      throw new Error(body.message ?? `the server refused to register this computer (${res.status})`);
    return {
      server_url: serverUrl,
      device_id: body.id,
      device_token: body.token,
      owner_user_id: body.owner_id,
      shared_roots: [],
      allow_exec: false,
    };
  }

  const log = (line: string): void => {
    logs.push(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
    if (logs.length > 1000) logs.shift();
    recordSidecarLine(line);
  };

  const snapshot = (): ServiceInfo[] => [{ name: SERVER, status, port, pid: null, detail: detail || serverUrl }];
  const changed = (): void => options.onChange?.(snapshot());
  const set = (next: ServiceStatusType, why = ""): void => {
    status = next;
    detail = why;
    changed();
  };

  /** This computer's link, if it was made for the server now configured. */
  const linked = (): HostConfig | null => {
    const config = readJson<HostConfig>(hostConfigFile);
    return config && normalize(config.server_url) === serverUrl ? config : null;
  };

  const connection = (): TeamConnection => {
    const config = linked();
    return {
      server_url: serverUrl,
      device_id: config?.device_id ?? null,
      device_name: hostname(),
      host: config ? hostState : "unlinked",
    };
  };

  // ---------------------------------------------------------------- the proxy

  async function startProxy(): Promise<void> {
    const forward = httpProxy.createProxyServer({ target: serverUrl, changeOrigin: true, xfwd: false });
    forward.on("error", (err, _req, res) => {
      log(`server unreachable: ${err.message}`);
      // `res` is a socket for upgrades; only an HTTP response can be answered.
      if ("writeHead" in res && !res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "server_unreachable", message: err.message, detail: err.message }));
      }
    });
    const server = createServer((req, res) => forward.web(req, res));
    server.on("upgrade", (req, socket, head) => forward.ws(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    proxy = server;
  }

  async function stopProxy(): Promise<void> {
    const server = proxy;
    proxy = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  async function healthy(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok && ((await res.json()) as { status?: string }).status !== undefined;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- the host

  const hostCli = (): string =>
    options.hostCli ??
    process.env["AGENT_BASE_HOST_CLI"] ??
    [
      path.join(process.resourcesPath ?? "", "host", "dist", "cli.js"),
      path.resolve(__dirname, "../../../host/dist/cli.js"),
      path.resolve(process.cwd(), "../host/dist/cli.js"),
    ].find((candidate) => existsSync(candidate)) ??
    "";

  function stopHost(): void {
    if (restart) clearTimeout(restart);
    restart = null;
    const child = host;
    host = null;
    child?.kill("SIGTERM");
    hostState = "stopped";
  }

  /** Run the host as a child process, and keep it running while this computer is linked. */
  function startHost(): void {
    stopHost();
    if (!linked()) return;
    const cli = hostCli();
    if (!cli) return void log("host entry point not found; set AGENT_BASE_HOST_CLI");
    hostState = "starting";
    // The app's own Electron binary doubles as the Node runtime for the host.
    const child = spawn(process.execPath, [cli, "run"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENT_BASE_HOME: hostHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    host = child;
    const onLine = (line: string): void => {
      log(`[host] ${line}`);
      if (child !== host) return;
      if (line.includes("link online")) hostState = "online";
      else if (line.includes("link rejected")) hostState = "rejected";
      else if (line.includes("link offline")) hostState = "offline";
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = "";
      stream?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line.trim());
      });
    }
    child.on("exit", (code) => {
      if (child !== host) return;
      host = null;
      log(`[host] exited (${code ?? "signal"})`);
      // A link the server rejected stays down until the member links again.
      if (stopping || hostState === "rejected") return;
      hostState = "offline";
      restart = setTimeout(startHost, HOST_RESTART_MS);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async function start(): Promise<ServiceInfo[]> {
    stopping = false;
    if (!serverUrl) {
      set("error", "no server configured");
      throw new Error("server_url_missing");
    }
    set("starting");
    if (!proxy) await startProxy();
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (!(await healthy(`http://127.0.0.1:${port}`))) {
      if (Date.now() > deadline) {
        set("error", `cannot reach ${serverUrl}`);
        throw new Error(`cannot reach the server at ${serverUrl}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    log(`connected to ${serverUrl}`);
    set("running");
    if (!host) startHost();
    return snapshot();
  }

  async function stop(): Promise<ServiceInfo[]> {
    stopping = true;
    stopHost();
    await stopProxy();
    set("stopped");
    return snapshot();
  }

  return {
    descriptors,
    startAllServices: start,
    stopAllServices: stop,
    async restartService() {
      await stop();
      return start();
    },
    getLogs: () => [...logs],
    getAgentServerInfo: () => ({ port, status, token: controlToken }),
    getDesktopControlToken: () => controlToken,
    getShellStatus: () => ({ ready: status === "running" }),
    getAllStatus: snapshot,
    registerDescriptor: (descriptor) => descriptors.register(descriptor),
    unregisterDescriptor: (name) => descriptors.unregister(name),

    // The host makes its own model calls; there is no sidecar whose network to manage.
    getEgressDiagnostics: () => options.egressManager?.getDiagnostics() ?? [],
    getEgressSnapshots: () => options.egressManager?.getSnapshots() ?? [],
    getEgressMode: () => options.egressManager?.getMode() ?? "off",
    getEgressStatus: () =>
      options.egressManager?.getStatus() ?? {
        mode: "off",
        enabled: false,
        started: false,
        emergencyOverride: false,
        snapshotCount: 0,
        diagnosticEventCount: 0,
      },
    getEgressRuntimePhases: () => options.egressManager?.getRuntimePhases() ?? [],
    async setEgressMode(mode) {
      await options.egressManager?.setMode(mode);
      return this.getEgressStatus();
    },

    getConnection: connection,

    async setServerUrl(url) {
      const next = normalize(url);
      if (!/^https?:\/\//.test(next)) throw new Error("the server address starts with http:// or https://");
      if (!(await healthy(next))) throw new Error(`no agent-base server answers at ${next}`);
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({ server_url: next }, null, 2));
      serverUrl = next;
      await stop();
      await start();
      return connection();
    },

    async linkDevice(accessToken, orgId) {
      const config = await register(accessToken, orgId ?? account?.orgId);
      const who = { orgId: orgId ?? account?.orgId ?? "", userId: config.owner_user_id };
      if (who.orgId) writeSecret(linksFile, { ...readLinks(), [keyOf(who)]: config });
      writeSecret(hostConfigFile, config);
      startHost();
      return connection();
    },

    async unlinkDevice() {
      stopHost();
      const config = readJson<HostConfig>(hostConfigFile);
      if (config) forgetLink(config.device_id);
      rmSync(hostConfigFile, { force: true });
      return connection();
    },

    async useAccount({ accessToken, orgId, userId, link }) {
      stopHost();
      account = { orgId, userId };
      const links = readLinks();
      const key = keyOf(account);
      let config = links[key] && normalize(links[key].server_url) === serverUrl ? links[key] : null;
      // A link made before links were kept per organization: it was this member's, in the one they had.
      const legacy = readJson<HostConfig>(hostConfigFile);
      if (!config && legacy && legacy.owner_user_id === userId && Object.keys(links).length === 0 && linked())
        config = legacy;
      if (!config && link !== false) config = await register(accessToken, orgId);
      if (!config) {
        rmSync(hostConfigFile, { force: true });
        return connection();
      }
      writeSecret(linksFile, { ...links, [key]: config });
      writeSecret(hostConfigFile, config);
      startHost();
      return connection();
    },

    async signOut() {
      stopHost();
      account = null;
      // With nobody signed in nothing runs here; the link itself is in links.json for their return.
      rmSync(hostConfigFile, { force: true });
      return connection();
    },
  };
}
