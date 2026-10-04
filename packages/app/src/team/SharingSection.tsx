/**
 * Settings → Sharing: everything the member owns that can be shared, in one
 * place — so sharing works without touching the pages those things live on.
 * (agent-base addition.)
 */
import { useState } from "react";
import { type ShareableType, agentsApi, projectsApi, providersApi, teamApi } from "@valuz/core";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, useI18n } from "@valuz/ui";
import { ShareDialog } from "./ShareDialog";
import { ErrorLine, Section, useLoaded } from "./shared";

interface Shareable {
  type: ShareableType;
  id: string;
  name: string;
}
/** The server marks what the caller may manage with `permission: "admin"`. */
type Owned = { id: string; name: string; permission?: string; kind?: string };
const mine = (type: ShareableType, rows: Owned[]): Shareable[] =>
  rows.filter((row) => row.permission === "admin").map((row) => ({ type, id: row.id, name: row.name }));

const TABS = ["agents", "projects", "providers", "devices"] as const;

export function SharingSection() {
  const { t } = useI18n();
  const [target, setTarget] = useState<Shareable | null>(null);
  const owned = useLoaded(async () => {
    const [agents, projects, providers, devices] = await Promise.all([
      agentsApi.listAgents(),
      projectsApi.list(),
      providersApi.list({ fresh: true }),
      teamApi.devices(),
    ]);
    return {
      agents: mine("agent", agents.agents as unknown as Owned[]),
      // A quick chat's own project is not something to share.
      projects: mine("project", (projects.projects as unknown as Owned[]).filter((p) => p.kind !== "chat")),
      providers: mine("provider", providers.providers as unknown as Owned[]),
      devices: mine("device", devices),
    };
  });

  return (
    <Section title={t("team.sharing.title")} description={t("team.sharing.desc")}>
      <ErrorLine message={owned.error} />
      <Tabs defaultValue="agents">
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`team.sharing.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((tab) => (
          <TabsContent key={tab} value={tab} className="flex flex-col gap-2">
            {owned.data?.[tab].length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("team.sharing.noneOwned", { type: t(`team.sharing.${tab}`) })}
              </p>
            ) : null}
            {owned.data?.[tab].map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>{item.name}</span>
                <Button variant="outline" size="sm" onClick={() => setTarget(item)}>
                  {t("team.sharing.share")}
                </Button>
              </div>
            ))}
          </TabsContent>
        ))}
      </Tabs>
      {target ? (
        <ShareDialog type={target.type} id={target.id} name={target.name} onClose={() => setTarget(null)} />
      ) : null}
    </Section>
  );
}
