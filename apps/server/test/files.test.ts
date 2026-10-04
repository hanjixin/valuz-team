import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import { type ModelGateway, startModelGateway } from "@agent-base/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

/**
 * Files stay on the device. The server relays: an upload on its way to a
 * session's workspace, a folder listing, the bytes of one file — each on the
 * caller's behalf, each subject to what the device's owner shares.
 */
describe("files", () => {
  let t: TestServer;
  let url: string;
  let model: ModelGateway;
  let dir: string; // the device's disk
  let folder: string; // a project's folder on it
  let host: Host;
  let alice: Account; // owns the device
  let bob: Account;
  let device: { id: string; token: string; owner_id: string };
  let projectId: string;

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const upload = async (account: Account, route: string, field: string, files: [string, string | Uint8Array][]) => {
    const form = new FormData();
    for (const [name, content] of files) form.append(field, new Blob([content]), name);
    const res = await fetch(`${url}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
      body: form,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary response shapes
    return { status: res.status, body: (await res.json()) as any };
  };
  const startHost = async (sharedRoots: string[]) => {
    await host?.stop();
    host = new Host({
      config: {
        server_url: url,
        device_id: device.id,
        device_token: device.token,
        owner_user_id: device.owner_id,
        shared_roots: sharedRoots,
        allow_exec: false,
      },
      dataDir: path.join(dir, "data"),
    });
    await host.start();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === true);
  };
  const stagedIn = async () =>
    readdir(path.join(t.env["STORAGE_DIR"] as string, "attachments", alice.orgId)).catch(() => []);

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1", MAX_UPLOAD_BYTES: "4096" });
    url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-files-")));
    folder = path.join(dir, "project");
    await mkdir(path.join(folder, "src", "deep"), { recursive: true });
    await writeFile(path.join(folder, "README.md"), "# Project");
    await writeFile(path.join(folder, "src", "main.ts"), "export {};");
    await writeFile(path.join(folder, "src", "deep", "leaf.txt"), "leaf");
    await writeFile(path.join(folder, ".env"), "SECRET=1");
    await writeFile(path.join(dir, "private.txt"), "not shared");
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    device = (await call(alice, "POST", "/v1/devices", { name: "Alice's Mac" })).body;
    await startHost([]);
    const channel = (
      await call(alice, "POST", "/v1/providers", {
        name: "Gateway",
        provider_kind: "compatible",
        api_key: "sk",
        base_url: model.url,
        models: ["test-model"],
      })
    ).body;
    await call(alice, "POST", "/v1/providers/default", { provider_id: channel.id });
    projectId = (await call(alice, "POST", "/v1/projects", { name: "Code", root_path: folder })).body.id;
  });
  afterAll(async () => {
    await host?.stop();
    await model?.stop();
    await t?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("holds an upload only until its message is sent, then it is on the device and gone from the server", async () => {
    const uploaded = await upload(alice, "/v1/attachments", "file", [["Q3 report.md", "# Q3\nRevenue: 42"]]);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({
      file_name: "Q3 report.md",
      size_bytes: 16,
      mime_type: "text/markdown",
      session_id: null,
      ref: "",
      consumed_at: null,
    });
    expect((await call(alice, "GET", "/v1/attachments")).body.items.map((i: { id: string }) => i.id)).toEqual([
      uploaded.body.id,
    ]);
    expect(await stagedIn()).toEqual([uploaded.body.id]);
    // Staged uploads are their uploader's alone.
    expect((await call(bob, "GET", "/v1/attachments")).body.items).toEqual([]);

    const session = (await call(alice, "POST", "/v1/sessions", { project_id: "chat-default" })).body;
    model.replies.push({ content: "Read it." });
    const sent = await call(alice, "POST", `/v1/sessions/${session.id}/messages`, {
      prompt: "Summarise this",
      attachment_ids: [uploaded.body.id],
    });
    expect(sent.status).toBe(200);
    await eventually(async () => (await call(alice, "GET", `/v1/sessions/${session.id}`)).body.status === "idle");

    // It is in the session's workspace on the device…
    const landed = path.join(
      dir,
      "data",
      "workspaces",
      `chat-${session.id}`,
      ".attachments",
      `${uploaded.body.id.slice(0, 8)}-Q3 report.md`,
    );
    expect(await readFile(landed, "utf8")).toBe("# Q3\nRevenue: 42");
    // …the agent was told where…
    expect(
      model.requests
        .at(-1)
        ?.messages.map((m) => m.content)
        .join("\n"),
    ).toContain(landed);
    // …it belongs to the session now, and the server kept no copy.
    const attached = (await call(alice, "GET", `/v1/sessions/${session.id}/attachments`)).body.items;
    expect(attached).toMatchObject([{ id: uploaded.body.id, session_id: session.id, ref: `valuz-file://${landed}` }]);
    expect(attached[0].consumed_at).toBeGreaterThan(0);
    expect((await call(alice, "GET", "/v1/attachments")).body.items).toEqual([]);
    expect(await stagedIn()).toEqual([]);
    expect((await call(alice, "GET", `/v1/sessions/${session.id}/artifacts`)).body).toEqual({ items: [] });
  });

  it("refuses an attachment that is someone else's, already used, or too large — and starts no turn", async () => {
    const mine = (await upload(alice, "/v1/attachments", "file", [["a.txt", "a"]])).body;
    const session = (await call(bob, "POST", "/v1/sessions", { project_id: "chat-default", device_id: device.id }))
      .body;
    expect(session.code).toBeDefined(); // bob may not use alice's device at all
    const own = (await call(alice, "POST", "/v1/sessions", { project_id: "chat-default" })).body;
    await call(alice, "PUT", `/v1/shares/session/${own.id}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "control",
    });
    const stolen = await call(bob, "POST", `/v1/sessions/${own.id}/messages`, {
      prompt: "hi",
      attachment_ids: [mine.id],
    });
    expect(stolen.status).toBe(404);
    expect((await call(alice, "GET", `/v1/sessions/${own.id}`)).body.status).toBe("created");
    expect((await call(alice, "GET", "/v1/attachments")).body.items).toHaveLength(1); // still staged

    const tooBig = await upload(alice, "/v1/attachments", "file", [["big.bin", new Uint8Array(5000)]]);
    expect([tooBig.status, tooBig.body.code]).toEqual([413, "file_too_large"]);
    expect((await upload(alice, "/v1/attachments", "file", [["empty.txt", ""]])).status).toBe(400);

    expect((await call(bob, "DELETE", `/v1/attachments/${mine.id}`)).status).toBe(404);
    expect((await call(alice, "DELETE", `/v1/attachments/${mine.id}`)).status).toBe(204);
    expect(await stagedIn()).toEqual([]);
  });

  it("shows a project's folder as the device has it, without holding a copy", async () => {
    const tree = (await call(alice, "GET", `/v1/projects/${projectId}/files`)).body;
    expect(tree).toMatchObject({ root: folder, device_online: true });
    const shape = (nodes: { name: string; type: string; children?: unknown[]; truncated?: boolean }[]): unknown =>
      nodes.map((n) => (n.type === "directory" ? [n.name, n.children ? shape(n.children as never) : "…"] : n.name));
    // Directories first; hidden files left out; cut off at the depth asked for.
    expect(shape(tree.files)).toEqual([["src", [["deep", "…"], "main.ts"]], "README.md"]);
    expect(tree.files[1]).toMatchObject({ name: "README.md", type: "file", size: 9 });
    expect(Date.parse(tree.files[1].modified)).toBeGreaterThan(0);

    const deep = (await call(alice, "GET", `/v1/projects/${projectId}/files?depth=3&include_hidden=true`)).body;
    expect(shape(deep.files)).toEqual([["src", [["deep", ["leaf.txt"]], "main.ts"]], ".env", "README.md"]);
    const sub = (await call(alice, "GET", `/v1/projects/${projectId}/files?path=src/deep`)).body;
    expect(sub).toMatchObject({ root: path.join(folder, "src", "deep"), files: [{ name: "leaf.txt" }] });
    expect((await call(alice, "GET", `/v1/projects/${projectId}/files?path=../`)).body.code).toBe("invalid_path");

    // What changes on the device is what the next listing shows.
    await writeFile(path.join(folder, "new.md"), "fresh");
    expect(
      (await call(alice, "GET", `/v1/projects/${projectId}/files`)).body.files.map((n: { name: string }) => n.name),
    ).toContain("new.md");
  });

  it("lets a teammate in only as far as the device's owner shares", async () => {
    await call(alice, "PUT", `/v1/shares/project/${projectId}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "edit",
    });
    const refused = await call(bob, "GET", `/v1/projects/${projectId}/files`);
    expect([refused.status, refused.body.code]).toEqual([403, "forbidden"]); // the folder is not shared on the device

    await startHost([folder]);
    expect((await call(bob, "GET", `/v1/projects/${projectId}/files`)).body.files.length).toBeGreaterThan(0);
    const written = await upload(bob, `/v1/projects/${projectId}/files`, "files", [
      ["docs/notes.md", "from bob"],
      ["todo.txt", "1"],
    ]);
    expect(written.body).toEqual({ project_id: projectId, written: ["docs/notes.md", "todo.txt"] });
    expect(await readFile(path.join(folder, "docs", "notes.md"), "utf8")).toBe("from bob");
    expect((await upload(bob, `/v1/projects/${projectId}/files`, "files", [["../escape.txt", "x"]])).body.code).toBe(
      "invalid_path",
    );

    await call(alice, "PUT", `/v1/shares/project/${projectId}`, {
      principal_type: "user",
      principal_id: bob.userId,
      permission: "view",
    });
    expect((await upload(bob, `/v1/projects/${projectId}/files`, "files", [["x.txt", "x"]])).status).toBe(403);
  });

  it("gives a file's bytes through a short-lived address, read from the device as the member who asked", async () => {
    const ref = (file: string) => `valuz-file://${file}`;
    const resolved = (
      await call(alice, "POST", "/v1/files/resolve", {
        refs: [ref(path.join(folder, "README.md")), ref(path.join(folder, "nope.md")), "not-a-ref"],
      })
    ).body.results;
    expect(resolved[0]).toMatchObject({
      kind: "remote",
      name: "README.md",
      mimeType: "text/markdown",
      size: 9,
      exists: true,
      previewKind: "markdown",
      capabilities: { canPreview: true, canDownload: true, canCopyContent: true },
      error: null,
    });
    expect(resolved[1]).toMatchObject({ exists: false, error: "not_found" });
    expect(resolved[2]).toMatchObject({ exists: false, error: "invalid_ref" });

    // The address works without a sign-in header — it is the authorization — and cannot run as a page.
    const res = await fetch(`${url}${resolved[0].url}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Project");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect((await fetch(`${url}${resolved[0].downloadUrl}`)).headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect((await fetch(`${url}/v1/files/raw/${alice.token}`)).status).toBe(404); // a sign-in token is not a file token
    expect((await fetch(`${url}/v1/files/raw/garbage`)).status).toBe(404);

    // bob may read what is shared with him on the device, and nothing beside it.
    const forBob = (
      await call(bob, "POST", "/v1/files/resolve", {
        refs: [ref(path.join(folder, "README.md")), ref(path.join(dir, "private.txt"))],
      })
    ).body.results;
    expect(forBob.map((r: { exists: boolean; error: string | null }) => [r.exists, r.error])).toEqual([
      [true, null],
      [false, "not_found"], // not in any project of his, so there is no device to ask
    ]);
  });

  it("answers plainly when the device is asleep", async () => {
    await host.stop();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === false);
    expect((await call(alice, "GET", `/v1/projects/${projectId}/files`)).body).toEqual({
      files: [],
      root: null,
      device_online: false,
    });
    const session = (await call(alice, "POST", "/v1/sessions", { project_id: "chat-default" })).body;
    const staged = (await upload(alice, "/v1/attachments", "file", [["later.txt", "later"]])).body;
    const sent = await call(alice, "POST", `/v1/sessions/${session.id}/messages`, {
      prompt: "read",
      attachment_ids: [staged.id],
    });
    expect([sent.status, sent.body.code]).toEqual([503, "device_offline"]);
    // Nothing was lost: the upload is still staged for when the device is back.
    expect((await call(alice, "GET", "/v1/attachments")).body.items.map((i: { id: string }) => i.id)).toEqual([
      staged.id,
    ]);
  });
});
