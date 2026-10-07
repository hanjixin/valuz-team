import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubSources } from "../src/modules/skills/import.ts";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

// Tests assert on arbitrary response shapes; typing each one would only add casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const manifest = (name: string, description = `Use ${name} when it applies.`) =>
  strToU8(`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`);

/**
 * Bringing skills in from outside: a zip a member uploads, or a link. A source
 * is previewed first — it may hold several skills — and each one chosen is
 * then taken into the member's library.
 */
describe("importing skills", () => {
  let t: TestServer;
  let url: string;
  let files: Server;
  let source: string;
  let alice: Account;
  let bob: Account;

  const call = (account: Account, method: string, route: string, body?: object) =>
    t.call(method, route, { token: account.token, ...(body ? { body } : {}) });
  const upload = async (account: Account, zip: Uint8Array, name = "skill.zip") => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(zip)], { type: "application/zip" }), name);
    const res = await fetch(`${url}/v1/skills/import/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const library = async (account: Account) =>
    ((await call(account, "GET", "/v1/skills")).body.skills as Json[])
      .filter((skill) => skill.source !== "builtin")
      .map((skill) => skill.slug)
      .sort();

  const single = zipSync({
    "release-notes/SKILL.md": manifest("Release Notes"),
    "release-notes/references/style.md": strToU8("Short sentences.\n"),
    "release-notes/scripts/collect.sh": strToU8("#!/bin/sh\ngit log --oneline\n"),
    "release-notes/logo.png": new Uint8Array([137, 80, 78, 71, 0, 0, 0, 1]),
    "__MACOSX/release-notes/._SKILL.md": strToU8("junk"),
  });
  const collection = zipSync({
    "pack/README.md": strToU8("Two skills.\n"),
    "pack/skills/triage/diagram.png": new Uint8Array([137, 80, 78, 71, 0, 0]),
    "pack/skills/triage/SKILL.md": manifest("Triage"),
    "pack/skills/triage/checklist.md": strToU8("- reproduce\n"),
    "pack/skills/postmortem/SKILL.md": strToU8("# Postmortem\n\nNo front matter here.\n"),
  });

  beforeAll(async () => {
    files = createServer((req, res) => {
      const send = (status: number, body: Uint8Array | string, type: string, extra: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": type, ...extra });
        res.end(body);
      };
      if (req.url === "/pack.zip") return send(200, collection, "application/octet-stream");
      if (req.url === "/moved.zip") return send(302, "", "text/plain", { location: "/pack.zip" });
      if (req.url === "/raw/SKILL.md") return send(200, manifest("Raw One"), "text/plain");
      if (req.url === "/picture.png") return send(200, new Uint8Array([137, 80, 78, 71, 0, 0]), "image/png");
      if (req.url === "/readme.zip")
        return send(200, zipSync({ "README.md": strToU8("nothing here") }), "application/zip");
      return send(404, "not found", "text/plain");
    });
    await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
    source = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
    t = await startTestServer({ ALLOW_PRIVATE_UPSTREAMS: "1" });
    url = await t.listen();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(async () => {
    await t?.stop();
    files.closeAllConnections();
    await new Promise((resolve) => files.close(resolve));
  });

  it("previews an uploaded zip, then takes the skill with its files — what is not text is left out, and said", async () => {
    const preview = await upload(alice, single);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      name: "Release Notes",
      description: "Use Release Notes when it applies.",
      name_conflict: false,
      suggested_name: null,
    });
    expect(preview.body.skills).toEqual([
      {
        preview_id: preview.body.preview_id,
        name: "Release Notes",
        description: preview.body.description,
        file_count: 3,
        relpath: "release-notes",
      },
    ]);
    // The one folder it came in is unwrapped; the tree nests.
    const tree = preview.body.file_tree as Json[];
    expect(tree.map((node) => [node.path, node.type])).toEqual([
      ["references", "directory"],
      ["scripts", "directory"],
      ["SKILL.md", "file"],
    ]);
    expect(tree[0].children).toMatchObject([{ path: "references/style.md", type: "file" }]);
    expect(preview.body.validation_warnings.join(" ")).toContain("1 file(s) that are not text");
    // Nothing is in the library until it is confirmed.
    expect(await library(alice)).toEqual([]);

    const taken = await call(alice, "POST", "/v1/skills/import/archive/confirm", {
      preview_id: preview.body.preview_id,
    });
    expect(taken.status).toBe(201);
    expect(taken.body).toMatchObject({
      slug: "release-notes",
      name: "Release Notes",
      creation_origin: "imported",
      readonly: false,
    });
    expect(
      (await call(alice, "GET", `/v1/skills/release-notes/files/${encodeURIComponent("scripts/collect.sh")}`)).body
        .content,
    ).toContain("git log");
    expect((await call(alice, "GET", "/v1/skills/release-notes")).body.file_count).toBe(3);
    // A preview is spent once taken, and is its member's alone.
    expect(
      (await call(alice, "POST", "/v1/skills/import/archive/confirm", { preview_id: preview.body.preview_id })).status,
    ).toBe(404);

    // The same again: said to clash, and taken under the name the member settles on.
    const again = await upload(alice, single);
    expect(again.body).toMatchObject({ name_conflict: true, suggested_name: "Release Notes (2)" });
    expect(
      (await call(bob, "POST", "/v1/skills/import/archive/confirm", { preview_id: again.body.preview_id })).status,
    ).toBe(404);
    const renamed = await call(alice, "POST", "/v1/skills/import/archive/confirm", {
      preview_id: again.body.preview_id,
      name: "Release Notes v2",
    });
    expect(renamed.body).toMatchObject({ slug: "release-notes-v2", name: "Release Notes v2" });
  });

  it("lists every skill a source holds, each taken on its own — from a link as from a file", async () => {
    const preview = await call(alice, "POST", "/v1/skills/import/url", { url: `${source}/moved.zip` });
    expect(preview.status).toBe(200);
    const found = preview.body.skills as Json[];
    expect(found.map((skill) => [skill.name, skill.relpath, skill.file_count])).toEqual([
      ["Triage", "pack/skills/triage", 2],
      ["postmortem", "pack/skills/postmortem", 1],
    ]);
    // What was left out is said for the skill it was left out of, not for its neighbours.
    const each = async (id: string) =>
      ((await t.server.ctx.redis.get(`skill-import:${alice.orgId}:${alice.userId}:${id}`)) ?? "") as string;
    expect(await each(found[0].preview_id)).toContain("1 file(s) that are not text");
    expect(await each(found[1].preview_id)).not.toContain("not text");
    // One with no front matter still comes in, under its folder's name — and the preview says what is missing.
    const second = await call(alice, "POST", "/v1/skills/import/url/confirm", { preview_id: found[1].preview_id });
    expect(second.body).toMatchObject({ slug: "postmortem" });
    const first = await call(alice, "POST", "/v1/skills/import/url/confirm", { preview_id: found[0].preview_id });
    expect(first.body).toMatchObject({ slug: "triage", description: "Use Triage when it applies." });
    expect(await library(alice)).toEqual(["postmortem", "release-notes", "release-notes-v2", "triage"]);

    // A link straight to a SKILL.md is a skill of one file.
    const raw = await call(alice, "POST", "/v1/skills/import/url", { url: `${source}/raw/SKILL.md` });
    expect(raw.body).toMatchObject({ name: "Raw One", skills: [{ file_count: 1, relpath: "" }] });
  });

  it("says why a source cannot be imported", async () => {
    const refused = async (res: { status: number; body: Json }) => [res.status, res.body.code, res.body.detail];
    expect(await refused(await upload(alice, strToU8("this is not a zip")))).toEqual([
      422,
      "import_failed",
      "that is not a zip archive",
    ]);
    expect((await refused(await upload(alice, zipSync({ "README.md": strToU8("no skill") }))))[2]).toContain(
      "no SKILL.md",
    );
    const link = (target: string) => call(alice, "POST", "/v1/skills/import/url", { url: target });
    expect((await refused(await link(`${source}/readme.zip`)))[2]).toContain("no SKILL.md");
    expect((await refused(await link(`${source}/gone.zip`)))[2]).toContain("nothing was found");
    expect((await refused(await link(`${source}/picture.png`)))[2]).toContain("neither a zip archive nor a SKILL.md");
    expect((await link("ftp://example.com/skill.zip")).status).toBe(400);
    expect((await link("not a link")).status).toBe(400);
  });

  it("reads a GitHub address as the repository's archive and the folder inside it", () => {
    const sources = (address: string) => githubSources(new URL(address));
    expect(sources("https://example.com/owner/repo")).toBeNull();
    // No branch named: the usual defaults are tried.
    expect(sources("https://github.com/acme/skills")).toEqual([
      { archive: "https://codeload.github.com/acme/skills/zip/main", subdir: "" },
      { archive: "https://codeload.github.com/acme/skills/zip/master", subdir: "" },
    ]);
    // A branch name may hold slashes, so each split is a candidate, shortest first.
    expect(sources("https://github.com/acme/skills/tree/release/v2/skills/triage")).toEqual([
      { archive: "https://codeload.github.com/acme/skills/zip/release", subdir: "v2/skills/triage" },
      { archive: "https://codeload.github.com/acme/skills/zip/release/v2", subdir: "skills/triage" },
      { archive: "https://codeload.github.com/acme/skills/zip/release/v2/skills", subdir: "triage" },
      { archive: "https://codeload.github.com/acme/skills/zip/release/v2/skills/triage", subdir: "" },
    ]);
    // A link to the SKILL.md itself means the folder it is in.
    expect(sources("https://github.com/acme/skills.git/blob/main/skills/triage/SKILL.md")?.[0]).toEqual({
      archive: "https://codeload.github.com/acme/skills/zip/main",
      subdir: "skills/triage",
    });
  });
});

describe("importing skills on a server with default settings", () => {
  it("will not fetch a link on a private network on a member's say-so", async () => {
    const t = await startTestServer();
    const alice = await signUp(t, "alice");
    const res = await t.call("POST", "/v1/skills/import/url", {
      token: alice.token,
      body: { url: "http://127.0.0.1:9/skill.zip" },
    });
    expect([res.status, res.body.code]).toEqual([400, "blocked_address"]);
    await t.stop();
  });
});
