/**
 * The bottom-left corner of the sidebar: who is signed in and which
 * organization they are working in, with the way to another organization and
 * out of the account. Settings has its own entry in the sidebar, so it is not
 * repeated here. (agent-base addition — it fills the sidebar's footer
 * slot, which upstream leaves for exactly this.)
 */
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, LogOut, Users } from "lucide-react";
import { authApi } from "@valuz/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useI18n,
} from "@valuz/ui";
import { useLoaded } from "./shared";
import { leaveAccount } from "./ThisComputer";

/** Everything on screen belongs to one organization: after moving, the app starts over in the other. */
export function moveToOrganization(orgId: string): void {
  authApi.switchOrganization(orgId);
  window.location.reload();
}

export async function signOut(): Promise<void> {
  // In the desktop app, first stop what runs on this computer for the member who is leaving.
  await leaveAccount();
  await authApi.logout();
}

export function AccountMenu() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const me = useLoaded(() => authApi.me());
  const user = me.data?.user;
  const orgs = me.data?.orgs ?? [];
  const current = orgs.find((org) => org.id === me.data?.current_org_id);
  if (!user) return null;
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="account-menu"
          aria-label={t("team.account.title")}
          className="mt-1 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 py-1.5 text-left hover:bg-surface-hover"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
            {initial}
          </span>
          {/* Narrow (the collapsed sidebar), only the initial is left showing. */}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink-heading">{user.name || user.email}</span>
            <span className="block truncate text-xs text-ink-meta">{current?.name ?? ""}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-ink-meta" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <div className="px-2 py-1.5">
          <div className="truncate text-sm font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </div>
        <DropdownMenuSeparator />
        <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">{t("team.account.organization")}</div>
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onSelect={() => {
              if (org.id !== current?.id) moveToOrganization(org.id);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{org.name}</span>
            {org.id === current?.id ? <Check className="ml-2 h-3.5 w-3.5 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => navigate("/settings?tab=team-org")}>
          <Users className="mr-2 h-3.5 w-3.5" />
          {t("team.account.manage")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="mr-2 h-3.5 w-3.5" />
          {t("team.account.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
