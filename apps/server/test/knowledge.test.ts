import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Host } from "@agent-base/host";
import { type ModelGateway, startModelGateway } from "@agent-base/test-utils";
import { parseOffice } from "officeparser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchTerms } from "../src/modules/knowledge/service.ts";
import { type Account, type TestServer, eventually, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * The organization's knowledge base lives on the server: documents are uploaded,
 * parsed in the background, searched by members, and consulted by agents on any
 * device through a toolkit the server hosts.
 */
describe("knowledge base", () => {
  let t: TestServer;
  let url: string;
  let model: ModelGateway;
  let dir: string;
  let host: Host;
  let alice: Account; // organization owner
  let bob: Account; // member
  let mallory: Account; // another organization
  let kbId: string;
  const docs: Record<string, string> = {};

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const upload = async (account: Account, kb: string, files: [string, string | Uint8Array][]) => {
    const form = new FormData();
    for (const [name, content] of files) form.append("files", new Blob([content]), name);
    const res = await fetch(`${url}/v1/kb/${kb}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const finished = (taskId: string) =>
    eventually(async () => {
      const task = (await call(alice, "GET", `/v1/docs/tasks/${taskId}`)).body;
      return task.status === "completed" && task;
    });
  const stored = async () =>
    (await readdir(path.join(t.env["STORAGE_DIR"] as string, "kb"), { recursive: true }).catch(() => [])).filter(
      (entry) => path.basename(entry).length === 36 && entry.split(path.sep).length === 3,
    );

  beforeAll(async () => {
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    url = await t.listen();
    model = await startModelGateway();
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "ab-kb-")));
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
    mallory = await signUp(t, "mallory");
  });
  afterAll(async () => {
    await host?.stop();
    await model?.stop();
    await t?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("splits a query into terms, with 2-character slices where there are no word boundaries", () => {
    expect(searchTerms("Travel  policy, a")).toEqual(["travel", "policy"]);
    expect(searchTerms("报销制度")).toEqual(["报销制度", "报销", "销制", "制度"]);
    expect(searchTerms(" ,. ")).toEqual([]);
  });

  it("is created by a member and seen by the whole organization, and by nobody outside it", async () => {
    const created = await call(bob, "POST", "/v1/kb", { name: "  Handbook " });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Handbook",
      root_path: "",
      document_count: 0,
      status: "all_ready",
      owner_id: bob.userId,
      editable: true,
    });
    kbId = created.body.id;
    expect((await call(alice, "GET", "/v1/kb")).body.knowledge_bases.map((kb: Json) => kb.name)).toEqual(["Handbook"]);
    expect((await call(mallory, "GET", "/v1/kb")).body.knowledge_bases).toEqual([]);
    expect((await call(mallory, "GET", `/v1/kb/${kbId}`)).status).toBe(404);
    expect((await call(alice, "GET", "/v1/kb/not-an-id")).status).toBe(404);
    expect((await call(bob, "POST", "/v1/kb", { name: "   " })).status).toBe(400);
  });

  it("parses what is uploaded — text and office formats — and reports progress", async () => {
    const docx = (
      await (await parseOffice(Buffer.from("# 报销制度\n\n差旅报销需在三十日内提交。"), { fileType: "md" })).to("docx")
    ).value as Uint8Array;
    const res = await upload(bob, kbId, [
      ["travel.md", "# Travel policy\n\nEconomy class for flights under six hours. Hotels up to 150 EUR per night."],
      ["hr/leave.txt", "Annual leave is 25 days. Unused leave carries over until March."],
      ["hr/policies/报销制度.docx", docx],
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task_type: "import_files", total_items: 3, kb_id: kbId });
    expect(await finished(res.body.task_id)).toMatchObject({ processed_items: 3, failed_items: 0 });

    const listed = (await call(alice, "GET", `/v1/docs?kb_id=${kbId}`)).body.documents;
    expect(listed.map((doc: Json) => [doc.relative_path, doc.status])).toEqual([
      ["hr/leave.txt", "ready"],
      ["hr/policies/报销制度.docx", "ready"],
      ["travel.md", "ready"],
    ]);
    for (const doc of listed) docs[doc.filename] = doc.id;
    expect(listed[0]).toMatchObject({ filename: "leave.txt", kb_id: kbId, chunk_count: 1, mime_type: "text/plain" });
    expect((await call(alice, "GET", `/v1/docs?kb_id=${kbId}&q=LEAVE`)).body.documents).toHaveLength(1);
    expect((await call(alice, "GET", `/v1/kb/${kbId}`)).body).toMatchObject({ document_count: 3, status: "all_ready" });
    expect((await call(alice, "GET", "/v1/docs/health")).body).toMatchObject({
      status: "healthy",
      total_documents: 3,
      ready_count: 3,
      failed_count: 0,
    });
    expect((await call(mallory, "GET", "/v1/docs")).body.documents).toEqual([]);
    expect((await call(mallory, "GET", `/v1/docs/${docs["travel.md"]}`)).status).toBe(404);
    expect((await call(mallory, "GET", `/v1/docs/tasks/${res.body.task_id}`)).status).toBe(404);
  });

  it("browses a knowledge base one folder at a time", async () => {
    const root = (await call(bob, "GET", `/v1/kb/${kbId}/tree`)).body.nodes;
    expect(root.map((node: Json) => [node.kind, node.name, node.document_count, node.status])).toEqual([
      ["folder", "hr", 2, "ready"],
      ["document", "travel.md", 0, "ready"],
    ]);
    const hr = (await call(bob, "GET", `/v1/kb/${kbId}/tree?folder_id=${root[0].id}`)).body.nodes;
    expect(hr.map((node: Json) => [node.kind, node.relative_path])).toEqual([
      ["folder", "hr/policies"],
      ["document", "hr/leave.txt"],
    ]);
    expect(hr[1].id).toBe(docs["leave.txt"]);
    const policies = (await call(bob, "GET", `/v1/kb/${kbId}/tree?folder_id=${hr[0].id}`)).body.nodes;
    expect(policies.map((node: Json) => node.name)).toEqual(["报销制度.docx"]);
    // A document says which folder it sits in, by the same id the tree uses.
    expect((await call(bob, "GET", `/v1/docs/${docs["leave.txt"]}`)).body.kb_folder_id).toBe(root[0].id);
    expect((await call(bob, "GET", `/v1/kb/${kbId}/tree?folder_id=nope`)).status).toBe(404);
  });

  it("previews the parsed text in windows that never split a character", async () => {
    const id = docs["报销制度.docx"];
    const whole = (await call(alice, "GET", `/v1/docs/${id}/preview`)).body;
    expect(whole.markdown).toBe("# 报销制度\n\n差旅报销需在三十日内提交。");
    expect(whole).toMatchObject({ offset: 0, truncated: false, returned_bytes: whole.total_bytes });
    // "# 报" is 5 bytes; a 4-byte window stops before the character it would cut.
    const first = (await call(alice, "GET", `/v1/docs/${id}/preview?max_bytes=4`)).body;
    expect(first).toMatchObject({ markdown: "# ", returned_bytes: 2, truncated: true });
    const next = (await call(alice, "GET", `/v1/docs/${id}/preview?offset=3&max_bytes=6`)).body;
    expect(next).toMatchObject({ markdown: "销制", offset: 5 });
  });

  it("opens a document's original file from the server's storage, for members of the organization", async () => {
    const detail = (await call(alice, "GET", `/v1/docs/${docs["leave.txt"]}`)).body;
    expect(detail.source_path).toBe(`kb/${docs["leave.txt"]}/leave.txt`);
    const ref = `valuz-file://${detail.source_path}`;
    const [found] = (await call(alice, "POST", "/v1/files/resolve", { refs: [ref] })).body.results;
    expect(found).toMatchObject({
      exists: true,
      kind: "remote",
      name: "leave.txt",
      mimeType: "text/plain",
      error: null,
    });
    const res = await fetch(`${url}${found.url}`);
    expect(await res.text()).toBe("Annual leave is 25 days. Unused leave carries over until March.");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    const [theirs] = (await call(mallory, "POST", "/v1/files/resolve", { refs: [ref] })).body.results;
    expect(theirs).toMatchObject({ exists: false, error: "not_found" });
  });

  it("searches passages by substring, in any language, within the organization", async () => {
    const project = (await call(alice, "POST", "/v1/projects", { name: "Ops" })).body.id;
    const search = async (query: string, extra: object = {}, as = alice) =>
      (await call(as, "POST", "/v1/docs/search", { query, project_id: project, ...extra })).body.hits;
    expect((await search("hotels flights")).map((hit: Json) => [hit.filename, hit.score])).toEqual([["travel.md", 1]]);
    expect((await search("差旅报销"))[0]).toMatchObject({ filename: "报销制度.docx", chunk_ref: "0" });
    expect((await search("leave hotels")).map((hit: Json) => hit.score)).toEqual([0.5, 0.5]);
    expect(await search("100%")).toEqual([]); // a wildcard character is only itself
    expect(await search("leave", { document_ids: [docs["travel.md"]] })).toEqual([]);
    expect(await search("leave", { document_ids: [docs["leave.txt"]] })).toHaveLength(1);

    // A project bound to part of the knowledge base searches only that part.
    const hr = (await call(alice, "GET", `/v1/kb/${kbId}/tree`)).body.nodes[0].id;
    const bound = await call(alice, "PUT", `/v1/projects/${project}/kb-bindings`, {
      bindings: [{ binding_kind: "folder", target_id: hr }],
    });
    expect(bound.body.bindings).toEqual([{ project_id: project, binding_kind: "folder", target_id: hr }]);
    expect(await search("hotels")).toEqual([]);
    expect(await search("leave")).toHaveLength(1);
    // Bob can see the project only if it is shared with him, and cannot rebind it without `edit`.
    expect((await call(bob, "GET", `/v1/projects/${project}/kb-bindings`)).status).toBe(404);
    // A binding cannot name another organization's knowledge base.
    const theirs = (await call(mallory, "POST", "/v1/kb", { name: "Theirs" })).body.id;
    const stolen = await call(alice, "PUT", `/v1/projects/${project}/kb-bindings`, {
      bindings: [{ binding_kind: "kb", target_id: theirs }],
    });
    expect(stolen.status).toBe(404);
    expect((await call(alice, "DELETE", `/v1/projects/${project}/kb-bindings`)).body).toEqual({ ok: true });
    expect(await search("hotels")).toHaveLength(1);
  });

  it("lets only the creator or an organization admin change a knowledge base", async () => {
    const carol = await joinOrg(t, alice, "carol");
    expect((await call(carol, "GET", `/v1/kb/${kbId}`)).body.editable).toBe(false);
    expect((await upload(carol, kbId, [["x.md", "x"]])).status).toBe(403);
    expect((await call(carol, "PATCH", `/v1/kb/${kbId}`, { name: "Mine" })).status).toBe(403);
    expect((await call(carol, "DELETE", `/v1/docs/${docs["travel.md"]}`)).status).toBe(403);
    expect((await call(carol, "DELETE", `/v1/kb/${kbId}`)).status).toBe(403);
    // Alice did not create it, but owns the organization.
    expect((await call(alice, "PATCH", `/v1/kb/${kbId}`, { name: "Company handbook" })).body.name).toBe(
      "Company handbook",
    );
  });

  it("refuses what it cannot parse or place, and says why a document failed", async () => {
    const refused = await upload(bob, kbId, [
      ["ok.md", "fine"],
      ["photo.png", "x"],
    ]);
    expect([refused.status, refused.body.code]).toEqual([400, "unsupported_file_type"]);
    expect(refused.body.message).toMatch(/photo\.png.*supported: \.md/);
    expect((await upload(bob, kbId, [["../escape.md", "x"]])).status).toBe(400);
    expect((await call(alice, "GET", `/v1/kb/${kbId}`)).body.document_count).toBe(3); // nothing half-added

    const res = await upload(bob, kbId, [["broken.pdf", "this is not a pdf"]]);
    expect(await finished(res.body.task_id)).toMatchObject({ processed_items: 1, failed_items: 1 });
    const broken = (await call(bob, "GET", `/v1/docs?kb_id=${kbId}&status=failed`)).body.documents[0];
    const detail = (await call(bob, "GET", `/v1/docs/${broken.id}`)).body;
    expect(detail).toMatchObject({ status: "failed", last_error_code: "parse_failed" });
    expect(detail.last_error_message).toBeTruthy();
    // Its uploader is told.
    const inbox = (await call(bob, "GET", "/v1/notifications")).body.entries;
    expect(inbox.map((entry: Json) => entry.kind)).toContain("document_failed");
    // Uploading to the same path replaces the document, and its stored file.
    const before = await stored();
    const again = await upload(bob, kbId, [["broken.pdf", "still not a pdf"]]);
    await finished(again.body.task_id);
    expect((await call(alice, "GET", `/v1/kb/${kbId}`)).body.document_count).toBe(4);
    expect((await stored()).length).toBe(before.length);
    // Rescanning retries what is not ready; reindexing retries what is named.
    const rescan = (await call(bob, "POST", `/v1/kb/${kbId}/rescan`)).body;
    expect(rescan).toMatchObject({ task_type: "rescan", total_items: 1 });
    await finished(rescan.task_id);
    const reindex = (await call(bob, "POST", "/v1/docs/reindex", { document_ids: [docs["travel.md"]] })).body;
    expect(await finished(reindex.task_id)).toMatchObject({
      task_type: "reindex",
      processed_items: 1,
      failed_items: 0,
    });
    expect((await call(bob, "POST", "/v1/docs/reindex", { document_ids: [crypto.randomUUID()] })).status).toBe(404);
    expect((await call(bob, "DELETE", `/v1/docs/${broken.id}`)).body).toEqual({ document_id: broken.id });
    expect((await stored()).length).toBe(before.length - 1);
  });

  it("gives an agent on a device the tools to consult it, as the session it runs in", async () => {
    const device = (await call(alice, "POST", "/v1/devices", { name: "Alice's Mac" })).body;
    host = new Host({
      config: {
        server_url: url,
        device_id: device.id,
        device_token: device.token,
        owner_user_id: device.owner_id,
        shared_roots: [],
        allow_exec: false,
      },
      dataDir: path.join(dir, "data"),
    });
    await host.start();
    await eventually(async () => (await call(alice, "GET", `/v1/devices/${device.id}`)).body.online === true);
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
    const session = (await call(alice, "POST", "/v1/sessions", { project_id: "chat-default", device_id: device.id }))
      .body;
    expect(session.id).toBeTruthy();

    model.replies.push(
      { tool: { name: "mcp__docs__doc_search", args: { query: "annual leave" } } },
      { tool: { name: "mcp__docs__doc_read", args: { document_id: docs["leave.txt"] } } },
      { tool: { name: "mcp__docs__list_doc_scope", args: {} } },
      { content: "25 days (leave.txt)." },
    );
    await call(alice, "POST", `/v1/sessions/${session.id}/messages`, { prompt: "How much leave do we get?" });
    const last = await eventually(async () => {
      const request = model.requests.at(-1);
      return request && request.messages.filter((m) => m.role === "tool").length === 3 && request;
    }, 20_000);
    expect(last.messages[0]?.content).toContain("## Knowledge base");
    expect(last.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["mcp__docs__doc_search", "mcp__docs__doc_read", "mcp__docs__list_doc_scope"]),
    );
    const [found, read, scope] = last.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content ?? ""));
    expect(found.results[0]).toMatchObject({ filename: "leave.txt", knowledge_base: "Company handbook" });
    expect(read).toMatchObject({ filename: "leave.txt", next_offset: null });
    expect(read.text).toContain("25 days");
    expect(scope.documents.map((doc: Json) => doc.relative_path)).toEqual([
      "hr/leave.txt",
      "hr/policies/报销制度.docx",
      "travel.md",
    ]);

    // The toolkit answers only a session's own token.
    const forged = await fetch(`${url}/v1/mcp/docs`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(forged.status).toBe(401);
  });

  it("attaches a document to a message by reference: its text reaches the device when the message is sent", async () => {
    const attach = (account: Account, ids: string[]) => call(account, "POST", "/v1/attachments/kb", { doc_ids: ids });
    const staged = await attach(alice, [docs["报销制度.docx"] as string, docs["leave.txt"] as string]);
    expect(staged.status).toBe(200);
    expect(staged.body.items.map((item: Json) => [item.file_name, item.source_kind, item.session_id])).toEqual([
      ["报销制度.docx", "kb_doc", null],
      ["leave.txt", "kb_doc", null],
    ]);
    // Staging the same document again adds nothing; one that is not there is refused.
    expect((await attach(alice, [docs["leave.txt"] as string])).body.items).toEqual([]);
    expect((await attach(alice, [crypto.randomUUID()])).body.code).toBe("document_unavailable");
    expect((await attach(mallory, [docs["leave.txt"] as string])).body.code).toBe("document_unavailable");
    expect((await call(alice, "GET", "/v1/attachments")).body.items).toHaveLength(2);
    // Nothing was copied into storage for them.
    expect(await stored()).toHaveLength(3);

    const [policy, leave] = staged.body.items;
    expect((await call(alice, "DELETE", `/v1/attachments/${leave.id}`)).status).toBe(204);
    const devices = (await call(alice, "GET", "/v1/devices")).body.devices;
    const session = (
      await call(alice, "POST", "/v1/sessions", { project_id: "chat-default", device_id: devices[0].id })
    ).body;
    model.replies.push({ content: "Thirty days." });
    const sent = await call(alice, "POST", `/v1/sessions/${session.id}/messages`, {
      prompt: "When must expenses be filed?",
      attachment_ids: [policy.id],
    });
    expect(sent.status).toBe(200);
    await eventually(async () => (await call(alice, "GET", `/v1/sessions/${session.id}`)).body.status === "idle");
    // The agent was handed the parsed text, as a file in its workspace.
    const landed = path.join(
      dir,
      "data",
      "workspaces",
      `chat-${session.id}`,
      ".attachments",
      `${policy.id.slice(0, 8)}-报销制度.docx.md`,
    );
    expect(await readFile(landed, "utf8")).toBe("# 报销制度\n\n差旅报销需在三十日内提交。");
    expect(model.requests.at(-1)?.messages.at(-1)?.content).toContain("报销制度.docx.md");
    const attached = (await call(alice, "GET", `/v1/sessions/${session.id}/attachments`)).body.items;
    expect(attached).toEqual([
      expect.objectContaining({ id: policy.id, source_kind: "kb_doc", session_id: session.id }),
    ]);
    expect((await call(alice, "GET", "/v1/attachments")).body.items).toEqual([]);
    // The document itself is untouched.
    expect((await call(alice, "GET", `/v1/docs/${docs["报销制度.docx"]}`)).body.status).toBe("ready");
  });

  it("deletes a knowledge base with its documents and their stored files", async () => {
    expect((await stored()).length).toBe(3);
    expect((await call(alice, "DELETE", `/v1/kb/${kbId}`)).body).toEqual({ kb_id: kbId });
    expect(await stored()).toEqual([]);
    expect((await call(alice, "GET", "/v1/docs")).body.documents).toEqual([]);
    expect((await call(alice, "GET", `/v1/kb/${kbId}`)).status).toBe(404);
    const actions = (await call(alice, "GET", "/v1/org/audit-logs?limit=200")).body.logs.map(
      (entry: Json) => entry.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["knowledge_base.create", "knowledge_base.delete"]));
  });
});
