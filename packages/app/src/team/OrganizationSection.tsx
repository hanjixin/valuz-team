/** Settings → Organization: members and their roles, invites, and teams. (agent-base addition.) */
import { useState } from "react";
import { type OrgInvite, type OrgRole, type Team, authApi, teamApi } from "@valuz/core";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useI18n,
} from "@valuz/ui";
import { ErrorLine, Section, attempt, useLoaded } from "./shared";
import { moveToOrganization as moveTo } from "./AccountMenu";

const ROLES: OrgRole[] = ["owner", "admin", "member"];

export function OrganizationSection() {
  const { t } = useI18n();
  const me = useLoaded(() => authApi.me());
  const org = useLoaded(() => teamApi.org());
  const members = useLoaded(() => teamApi.members());
  const teams = useLoaded(() => teamApi.teams());
  const canManage = me.data?.role === "owner" || me.data?.role === "admin";
  // Only owners and admins may list invites; for everyone else there is nothing to show.
  const invites = useLoaded(() => teamApi.invites().catch(() => [] as OrgInvite[]));

  const [error, setError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [created, setCreated] = useState<OrgInvite | null>(null);
  const [teamName, setTeamName] = useState("");
  const [editing, setEditing] = useState<Team | null>(null);

  const act = async (action: () => Promise<unknown>, ...then: (() => void)[]) => {
    setError(await attempt(action));
    then.forEach((reload) => reload());
  };
  const inviteLink = (token: string) => `${window.location.origin}/?invite=${token}`;

  const [newOrg, setNewOrg] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <ErrorLine message={error ?? members.error ?? org.error} />

      <Section title={t("team.org.title")}>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t("team.org.name")}
            disabled={!canManage}
            value={orgName ?? org.data?.name ?? ""}
            onChange={(event) => setOrgName(event.target.value)}
          />
          {canManage ? (
            <Button
              disabled={!orgName?.trim() || orgName === org.data?.name}
              onClick={() => void act(() => teamApi.renameOrg(orgName ?? ""), org.reload)}
            >
              {t("team.common.save")}
            </Button>
          ) : null}
        </div>
        {/* Switching organizations and signing out are in the account menu, bottom left; a new one starts here. */}
        <div className="mt-3 flex items-center gap-2" data-testid="new-organization">
          <Input
            aria-label={t("team.account.newOrganization")}
            placeholder={t("team.account.newOrganization")}
            value={newOrg}
            onChange={(event) => setNewOrg(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={!newOrg.trim()}
            onClick={() =>
              void (async () => {
                let created: { id: string } | null = null;
                setError(await attempt(async () => void (created = await authApi.createOrganization(newOrg.trim()))));
                if (created) moveTo((created as { id: string }).id);
              })()
            }
          >
            {t("team.account.create")}
          </Button>
        </div>
      </Section>

      <Section title={t("team.org.members")} description={t("team.org.membersDesc")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("team.org.members")}</TableHead>
              <TableHead>{t("team.org.email")}</TableHead>
              <TableHead>{t("team.org.role")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data?.map((member) => {
              const self = member.id === me.data?.user.id;
              return (
                <TableRow key={member.id}>
                  <TableCell>
                    {member.name} {self ? <Badge variant="outline">{t("team.common.you")}</Badge> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{member.email}</TableCell>
                  <TableCell>
                    {canManage && !self ? (
                      <NativeSelect
                        aria-label={`${t("team.org.role")} · ${member.name}`}
                        value={member.role}
                        onChange={(event) =>
                          void act(
                            () => teamApi.setRole(member.id, event.target.value as OrgRole),
                            members.reload,
                          )
                        }
                      >
                        {ROLES.map((role) => (
                          <NativeSelectOption key={role} value={role}>
                            {t(`team.role.${role}`)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    ) : (
                      t(`team.role.${member.role}`)
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && !self ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!window.confirm(t("team.org.removeConfirm", { name: member.name }))) return;
                          void act(() => teamApi.removeMember(member.id), members.reload, teams.reload);
                        }}
                      >
                        {t("team.common.remove")}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>

      {canManage ? (
        <Section title={t("team.org.invites")} description={t("team.org.invitesDesc")}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                setCreated(await teamApi.invite(inviteEmail, "member"));
                setInviteEmail("");
              }, invites.reload);
            }}
          >
            <Input
              type="email"
              required
              aria-label={t("team.org.inviteEmail")}
              placeholder={t("team.org.inviteEmail")}
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
            <Button type="submit">{t("team.org.invite")}</Button>
          </form>
          {created?.token ? (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3 text-sm">
              <span>{t("team.org.inviteCreated")}</span>
              <code data-testid="invite-link" className="break-all">
                {inviteLink(created.token)}
              </code>
            </div>
          ) : null}
          {invites.data?.map((invite) => (
            <div key={invite.id} className="flex items-center justify-between text-sm">
              <span>
                {invite.email} · {t(`team.role.${invite.role}`)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void act(() => teamApi.revokeInvite(invite.id), invites.reload)}
              >
                {t("team.org.revoke")}
              </Button>
            </div>
          ))}
        </Section>
      ) : null}

      <Section title={t("team.org.teams")} description={t("team.org.teamsDesc")}>
        {canManage ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await teamApi.createTeam(teamName);
                setTeamName("");
              }, teams.reload);
            }}
          >
            <Input
              required
              aria-label={t("team.org.teamName")}
              placeholder={t("team.org.teamName")}
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
            />
            <Button type="submit">{t("team.org.createTeam")}</Button>
          </form>
        ) : null}
        {teams.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("team.common.empty")}</p>
        ) : null}
        {teams.data?.map((team) => (
          <div key={team.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {team.name}{" "}
                <span className="font-normal text-muted-foreground">
                  {t("team.org.teamMembers", { count: team.member_ids.length })}
                </span>
              </span>
              {canManage ? (
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(editing?.id === team.id ? null : team)}
                  >
                    {t("team.org.members")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void act(() => teamApi.deleteTeam(team.id), teams.reload)}
                  >
                    {t("team.org.deleteTeam")}
                  </Button>
                </span>
              ) : null}
            </div>
            {editing?.id === team.id
              ? members.data?.map((member) => (
                  <label key={member.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={team.member_ids.includes(member.id)}
                      onCheckedChange={(checked) =>
                        void act(
                          () =>
                            teamApi.setTeamMembers(
                              team.id,
                              checked
                                ? [...team.member_ids, member.id]
                                : team.member_ids.filter((id) => id !== member.id),
                            ),
                          teams.reload,
                        )
                      }
                    />
                    {member.name}
                  </label>
                ))
              : null}
          </div>
        ))}
      </Section>
    </div>
  );
}
