import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundlesFor } from "../src/modules/skills/service.ts";
import { type Account, type TestServer, joinOrg, signUp, startTestServer } from "./harness.ts";

describe("skills", () => {
  let t: TestServer;
  let alice: Account;
  let bob: Account;
  let skillId: string;

  const call = (account: Account, method: string, url: string, body?: object) =>
    t.call(method, url, { token: account.token, ...(body ? { body } : {}) });
  const file = async (account: Account, path: string) =>
    (await call(account, "GET", `/v1/skills/${skillId}/files/${encodeURIComponent(path)}`)).body;

  beforeAll(async () => {
    t = await startTestServer();
    alice = await signUp(t, "alice");
    bob = await joinOrg(t, alice, "bob");
  });
  afterAll(() => t?.stop());

  it("creates a skill as a package whose SKILL.md says what it is", async () => {
    const created = await call(alice, "POST", "/v1/skills", {
      name: "DCF Model",
      description: "Value a company from its cash flows",
      instructions_markdown: "# DCF\n\nProject five years, then discount.",
    });
    expect(created.status).toBe(201);
    skillId = created.body.id;
    expect(created.body).toMatchObject({
      slug: "dcf-model",
      name: "DCF Model",
      scope: "user",
      source: "user",
      path: "skills/dcf-model",
      enabled: true,
      library_enabled: true,
      readonly: false,
      version: 1,
      creation_origin: "created",
    });
    expect((await file(alice, "SKILL.md")).content).toBe(
      "---\nname: DCF Model\ndescription: Value a company from its cash flows\n---\n# DCF\n\nProject five years, then discount.\n",
    );
    const detail = (await call(alice, "GET", "/v1/skills/dcf-model")).body; // by slug, as agents refer to it
    expect(detail).toMatchObject({
      id: skillId,
      instructions_markdown: "# DCF\n\nProject five years, then discount.\n",
      file_count: 1,
      manifest_filename: "SKILL.md",
      metadata: { name: "DCF Model" },
    });
    // The same name again gets the next free slug.
    expect((await call(alice, "POST", "/v1/skills", { name: "DCF Model" })).body.slug).toBe("dcf-model-2");
    expect((await call(alice, "GET", "/v1/skills?project_id=chat-default")).body).toMatchObject({
      project_id: "chat-default",
      skills: [{ slug: "dcf-model" }, { slug: "dcf-model-2" }],
    });
  });

  it("holds files in a tree, keeps them inside the package, and never loses its SKILL.md", async () => {
    const act = (body: object) => call(alice, "POST", `/v1/skills/${skillId}/files`, body);
    expect((await act({ action: "create", path: "scripts/model.py", content: "print('dcf')" })).status).toBe(201);
    await act({ action: "create", path: "reference/wacc.md", content: "# WACC" });
    await act({ action: "rename", path: "reference/wacc.md", new_path: "reference/cost-of-capital.md" });

    const tree = (await call(alice, "GET", `/v1/skills/${skillId}/files`)).body;
    expect(tree).toEqual([
      {
        name: "reference",
        path: "reference",
        type: "directory",
        children: [{ name: "cost-of-capital.md", path: "reference/cost-of-capital.md", type: "file", size: 6 }],
      },
      {
        name: "scripts",
        path: "scripts",
        type: "directory",
        children: [{ name: "model.py", path: "scripts/model.py", type: "file", size: 12 }],
      },
      { name: "SKILL.md", path: "SKILL.md", type: "file", size: expect.any(Number) },
    ]);
    expect((await file(alice, "scripts/model.py")).content).toBe("print('dcf')");

    for (const path of ["../outside.txt", "/etc/passwd", "a//b", "a/./b"])
      expect((await act({ action: "create", path, content: "x" })).body.code).toBe("invalid_path");
    expect((await act({ action: "delete", path: "SKILL.md" })).status).toBe(400);
    expect((await act({ action: "rename", path: "SKILL.md", new_path: "README.md" })).status).toBe(400);
    expect(
      (await act({ action: "rename", path: "scripts/model.py", new_path: "reference/cost-of-capital.md" })).status,
    ).toBe(409);
    expect((await act({ action: "delete", path: "nope.txt" })).status).toBe(404);
  });

  it("keeps every version, and restores an old one as a new version", async () => {
    await call(alice, "PATCH", `/v1/skills/${skillId}`, { description: "Value a company (v2)" });
    // Editing SKILL.md by hand changes the name and description it declares.
    await call(alice, "POST", `/v1/skills/${skillId}/files`, {
      action: "create",
      path: "SKILL.md",
      content: "---\nname: DCF Valuation\ndescription: Renamed in the file\n---\nNew body\n",
    });
    expect((await call(alice, "GET", `/v1/skills/${skillId}`)).body).toMatchObject({
      name: "DCF Valuation",
      description: "Renamed in the file",
      slug: "dcf-model", // the handle agents use does not move
      instructions_markdown: "New body\n",
    });
    // Saving the same thing again is not a new version.
    await call(alice, "PATCH", `/v1/skills/${skillId}`, { description: "Renamed in the file" });

    const versions = (await call(alice, "GET", `/v1/skills/${skillId}/versions`)).body;
    expect(
      versions.items.map((v: { version_no: number; is_current: boolean }) => [v.version_no, v.is_current]),
    ).toEqual([
      [6, true],
      [5, false],
      [4, false],
      [3, false],
      [2, false],
      [1, false],
    ]);
    const first = versions.items.at(-1);
    const detail = (await call(alice, "GET", `/v1/skills/${skillId}/versions/${first.revision_id}`)).body;
    expect(detail.files).toEqual([{ path: "SKILL.md", size: expect.any(Number) }]);
    const old = await call(alice, "GET", `/v1/skills/${skillId}/versions/${first.revision_id}/files?path=SKILL.md`);
    expect(old.body.content).toContain("Project five years");

    const restored = await call(alice, "POST", `/v1/skills/${skillId}/versions/${first.revision_id}/restore`);
    expect(restored.body).toMatchObject({ version_no: 7, skill: { name: "DCF Model", version: 7 } });
    expect((await call(alice, "GET", `/v1/skills/${skillId}/files`)).body).toHaveLength(1); // only SKILL.md, as it was
    const current = (await call(alice, "GET", `/v1/skills/${skillId}/versions`)).body.items[0];
    expect((await call(alice, "POST", `/v1/skills/${skillId}/versions/${current.revision_id}/restore`)).status).toBe(
      400,
    );
  });

  it("is private until shared; `edit` lets a colleague change it, and a copy is their own", async () => {
    expect((await call(bob, "GET", "/v1/skills")).body.skills).toEqual([]);
    expect((await call(bob, "GET", `/v1/skills/${skillId}`)).status).toBe(404);
    const share = (permission: string) =>
      call(alice, "PUT", `/v1/shares/skill/${skillId}`, {
        principal_type: "user",
        principal_id: bob.userId,
        permission,
      });

    await share("use");
    expect((await call(bob, "GET", `/v1/skills/${skillId}`)).body).toMatchObject({ source: "org", readonly: true });
    expect((await call(bob, "PATCH", `/v1/skills/${skillId}`, { name: "Mine" })).status).toBe(403);
    expect((await call(bob, "DELETE", `/v1/skills/${skillId}?mode=confirm`)).status).toBe(403);

    await share("edit");
    expect((await call(bob, "PATCH", `/v1/skills/${skillId}`, { description: "Edited by bob" })).body.readonly).toBe(
      false,
    );

    const copied = await call(bob, "POST", `/v1/skills/${skillId}/copy`, { new_name: "Bob's DCF" });
    expect(copied.body).toMatchObject({ slug: "bobs-dcf", source: "user", version: 1 });
    expect((await call(bob, "GET", `/v1/skills/${copied.body.id}`)).body.instructions_markdown).toContain(
      "Project five years",
    );
  });

  it("each member switches skills on and off in their own library only", async () => {
    const off = await call(bob, "PUT", `/v1/skills/${skillId}/library-state`, { enabled: false });
    expect(off.body).toMatchObject({ library_enabled: false, enabled: false });
    const forBob = (await call(bob, "GET", "/v1/skills")).body.skills.find((s: { id: string }) => s.id === skillId);
    const forAlice = (await call(alice, "GET", "/v1/skills")).body.skills.find((s: { id: string }) => s.id === skillId);
    expect([forBob.library_enabled, forAlice.library_enabled]).toEqual([false, true]);
    expect(
      (await call(bob, "PUT", `/v1/skills/${skillId}/library-state`, { enabled: true })).body.library_enabled,
    ).toBe(true);
  });

  it("hands a turn the current package of each skill its agent names", async () => {
    await call(alice, "POST", `/v1/skills/${skillId}/files`, { action: "create", path: "notes.md", content: "latest" });
    const bundles = await bundlesFor(t.server.ctx, alice.orgId, ["dcf-model", "no-such-skill"]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({ slug: "dcf-model", version: 9 });
    expect(bundles[0]?.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "notes.md"]);
  });

  it("deleting says what it would affect first, then takes the skill, its versions and its shares", async () => {
    const preview = await call(alice, "DELETE", `/v1/skills/${skillId}`);
    expect([preview.status, preview.body]).toEqual([200, { affected_projects: [] }]);
    expect((await call(alice, "GET", `/v1/skills/${skillId}`)).status).toBe(200);
    expect((await call(alice, "DELETE", `/v1/skills/${skillId}?mode=confirm`)).status).toBe(204);
    expect((await call(alice, "GET", `/v1/skills/${skillId}`)).status).toBe(404);
    const db = t.server.ctx.db;
    expect(await db.selectFrom("skill_versions").select("id").where("skill_id", "=", skillId).execute()).toEqual([]);
    expect(await db.selectFrom("resource_shares").select("id").where("resource_id", "=", skillId).execute()).toEqual(
      [],
    );
    expect((await call(alice, "POST", "/v1/skills/scan")).body).toEqual({ indexed: 2 }); // the spare one, and bob's copy (alice owns the organization)
  });
});
