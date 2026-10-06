import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sidecar-log", () => ({ recordSidecarLine: () => undefined }));

import { createTeamServiceManager } from "./team";

/**
 * agent-base: a computer is a device in one organization for one member, so the
 * desktop keeps a link per account-in-an-organization and moves between them
 * as people sign in, switch and sign out.
 */
describe("this computer's links, per account and organization", () => {
  const SERVER = "http://team.example";
  let dir: string;
  let registered: { org: string | null; token: string }[];

  const manager = () => createTeamServiceManager(dir, { hostCli: "/nonexistent/host-cli.js" });
  const active = () => {
    const file = path.join(dir, "host", "host.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { device_id: string }) : null;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ab-team-"));
    writeFileSync(path.join(dir, "desktop.json"), JSON.stringify({ server_url: SERVER }));
    registered = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        const token = init.headers["authorization"]?.replace("Bearer ", "") ?? "";
        registered.push({ org: init.headers["x-org-id"] ?? null, token });
        return new Response(
          JSON.stringify({ id: `device-${registered.length}`, token: "dev_secret", owner_id: token.replace("token-", "") }),
          { status: 201 },
        );
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links the computer for whoever signs in, in the organization they act in — once", async () => {
    const team = manager();
    const first = await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" });
    expect(first.device_id).toBe("device-1");
    expect(registered).toEqual([{ org: "org-a", token: "token-alice" }]);
    // Signing in again, or restarting the app, takes the same link up: nothing new is registered.
    expect((await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" })).device_id).toBe(
      "device-1",
    );
    expect((await manager().useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" })).device_id).toBe(
      "device-1",
    );
    expect(registered).toHaveLength(1);
  });

  it("has a link of its own in each organization, and goes back to the one it had", async () => {
    const team = manager();
    await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" });
    expect((await team.useAccount({ accessToken: "token-alice", orgId: "org-b", userId: "alice" })).device_id).toBe(
      "device-2",
    );
    expect(registered[1]).toEqual({ org: "org-b", token: "token-alice" });
    expect((await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" })).device_id).toBe(
      "device-1",
    );
    expect(active()?.device_id).toBe("device-1");
    expect(registered).toHaveLength(2);
  });

  it("stops being anyone's device when they sign out, and is theirs again when they return", async () => {
    const team = manager();
    await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" });
    expect((await team.signOut()).device_id).toBeNull();
    expect(active()).toBeNull();
    // Someone else on the same computer gets a link of their own, not alice's.
    expect((await team.useAccount({ accessToken: "token-bob", orgId: "org-a", userId: "bob" })).device_id).toBe(
      "device-2",
    );
    await team.signOut();
    expect((await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" })).device_id).toBe(
      "device-1",
    );
    expect(registered).toHaveLength(2);
  });

  it("keeps a computer unlinked when its member chose that, and forgets a link they removed", async () => {
    const team = manager();
    expect(
      (await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice", link: false })).device_id,
    ).toBeNull();
    expect(registered).toEqual([]);
    await team.linkDevice("token-alice", "org-a");
    expect(active()?.device_id).toBe("device-1");
    await team.unlinkDevice();
    // Unlinked by hand: signing in again does not quietly bring the old link back.
    expect(
      (await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice", link: false })).device_id,
    ).toBeNull();
  });

  it("adopts a link made before links were kept per organization", async () => {
    mkdirSync(path.join(dir, "host"), { recursive: true });
    writeFileSync(
      path.join(dir, "host", "host.json"),
      JSON.stringify({ server_url: SERVER, device_id: "old-device", device_token: "t", owner_user_id: "alice", shared_roots: [], allow_exec: false }),
    );
    const team = manager();
    expect((await team.useAccount({ accessToken: "token-alice", orgId: "org-a", userId: "alice" })).device_id).toBe(
      "old-device",
    );
    expect(registered).toEqual([]);
    // It is alice's: bob signing in does not inherit it.
    await team.signOut();
    expect((await team.useAccount({ accessToken: "token-bob", orgId: "org-a", userId: "bob" })).device_id).toBe(
      "device-1",
    );
  });
});
