/**
 * A stand-in for the market index: a few items of each kind, the detail of
 * each with its install manifest, and skill packages to download.
 */
import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";

export interface MarketIndex {
  url: string;
  /** Every request path asked of the index, in order. */
  requests: string[];
  /** Answer nothing but errors, as an index that is down. */
  down: boolean;
  stop(): Promise<void>;
}

const zips = new Map<string, Uint8Array>();
/** One package per skill: a zip carries the time it was made, so it is made once and its digest stays true. */
const skillZip = (slug: string): Uint8Array => {
  let zip = zips.get(slug);
  if (!zip) zips.set(slug, (zip = packSkill(slug)));
  return zip;
};
const packSkill = (slug: string): Uint8Array =>
  zipSync({
    [`${slug}/SKILL.md`]: strToU8(`---\nname: ${slug}\ndescription: The ${slug} skill.\n---\n\nUse ${slug} well.\n`),
    [`${slug}/references/notes.md`]: strToU8("Notes.\n"),
    [`${slug}/logo.png`]: new Uint8Array([137, 80, 78, 71, 0, 0, 0]),
  });

export async function startMarketIndex(): Promise<MarketIndex> {
  const requests: string[] = [];
  const base = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const summary = (id: string, type: string, title: string, extra: object = {}) => ({
    id,
    type,
    source: "valuz_official",
    source_ref: id.split(":")[2],
    title,
    subtitle: null,
    description: `${title}.`,
    icon: null,
    category: "development",
    category_label: "开发编程",
    subcategories: [],
    scenario_tags: [],
    badges: [],
    stats: { downloads: null, stars: null, installs: null, views: null },
    version: "1.0.0",
    runtime: null,
    skill_count: null,
    members: null,
    install_target: "skill_library",
    installed: false,
    locked: false,
    connector_count: null,
    composition: null,
    ...extra,
  });
  const download = (slug: string) => `${base()}/v1/marketplace/items/market:skill:${slug}/download`;
  const skill = (slug: string) => ({
    ...summary(`market:skill:${slug}`, "skill", slug),
    install_manifest: {
      download_url: download(slug),
      sha256: createHash("sha256").update(skillZip(slug)).digest("hex"),
    },
  });
  const role = (slug: string, name: string, skills: string[]) => ({
    slug,
    name: { "zh-CN": name, "en-US": `${slug} (en)` },
    description: { "zh-CN": `${name}的职责`, "en-US": "Role" },
    instructions: { "zh-CN": `你是${name}。`, "en-US": `You are ${slug}.` },
    avatar: "compass",
    runtime: "claude_agent",
    effort: "high",
    skills,
  });
  // Built once the index is listening: the items name its own address for downloads.
  const catalogue = (): Record<string, object> => ({
    "market:skill:code-review": skill("code-review"),
    "market:skill:release-notes": skill("release-notes"),
    "market:connector:task-master": {
      ...summary("market:connector:task-master", "connector", "task-master"),
      connector_config: {
        slug: "task-master",
        transport: "stdio",
        url: null,
        command: "npx",
        args: ["-y", "task-master"],
        env: {},
        headers: {},
        params: {},
        auth_type: "none",
        fields: [],
        supported: true,
        unsupported_reason: null,
      },
      install_manifest: null,
    },
    "market:agent:reviewer": {
      ...summary("market:agent:reviewer", "agent_template", "代码审查员"),
      install_manifest: {
        // A single agent's manifest says what it does as its `role`; it has no `description`.
        ...role("reviewer", "代码审查员", []),
        description: undefined,
        role: { "zh-CN": "审查代码", "en-US": "Reviews code" },
        skills: [{ slug: "code-review" }, { slug: "no-such-skill" }],
      },
    },
    "market:team:release-crew": {
      ...summary("market:team:release-crew", "agent_team_template", "发布小组", {
        members: [
          { slug: "rc-lead", name: "发布负责人", role: "lead", lead: true, skill_count: 1 },
          { slug: "rc-writer", name: "文档撰写", role: "writer", lead: false, skill_count: 1 },
        ],
      }),
      install_manifest: {
        collection: { id: "release-crew" },
        agents: [role("rc-lead", "发布负责人", ["code-review"]), role("rc-writer", "文档撰写", ["release-notes"])],
        skills: [
          { slug: "code-review", source: "url", download_url: download("code-review") },
          { slug: "release-notes", source: "url", download_url: download("release-notes") },
        ],
      },
    },
  });
  let details: Record<string, object> = {};
  const state = { down: false };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const path = decodeURIComponent(url.pathname);
    requests.push(path);
    const json = (payload: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (state.down) return json({ error: "down" }, 503);
    if (path === "/v1/marketplace/categories")
      return json({ categories: [{ key: "development", label: "开发编程", count: 2, subcategories: [] }] });
    if (path === "/v1/marketplace/items") {
      const type = url.searchParams.get("type");
      const items = Object.values(details)
        .map((detail) => summary((detail as { id: string }).id, (detail as { type: string }).type, "", detail))
        .filter((item) => item.type === type)
        .map(({ install_manifest: _manifest, connector_config: _config, ...item }: Record<string, unknown>) => item);
      return json({ items, total: items.length, page: 1, page_size: 30, degraded: false });
    }
    const downloaded = /^\/v1\/marketplace\/items\/market:skill:([a-z-]+)\/download$/.exec(path);
    if (downloaded?.[1]) {
      res.setHeader("content-type", "application/zip");
      return void res.end(Buffer.from(skillZip(downloaded[1])));
    }
    const detail = details[path.replace("/v1/marketplace/items/", "")];
    return detail ? json(detail) : json({ detail: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  details = catalogue();
  return {
    url: base(),
    requests,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
