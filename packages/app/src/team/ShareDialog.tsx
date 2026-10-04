/** Who a resource is shared with, and how far each may go. (agent-base addition.) */
import { useState } from "react";
import {
  type PrincipalType,
  type ShareableType,
  type SharePermission,
  teamApi,
} from "@valuz/core";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  NativeSelect,
  NativeSelectOption,
  useI18n,
} from "@valuz/ui";
import { ErrorLine, attempt, useLoaded } from "./shared";

const LADDER: SharePermission[] = ["view", "use", "edit", "control"];
/** `control` only means something for things that can be driven remotely. */
const ladderFor = (type: ShareableType): SharePermission[] =>
  type === "device" || type === "session" ? LADDER : LADDER.slice(0, 3);

export function ShareDialog({
  type,
  id,
  name,
  onClose,
}: {
  type: ShareableType;
  id: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const shares = useLoaded(() => teamApi.shares(type, id));
  const people = useLoaded(() => Promise.all([teamApi.members(), teamApi.teams()]));
  const [principalType, setPrincipalType] = useState<PrincipalType>("org");
  const [principalId, setPrincipalId] = useState("");
  const [permission, setPermission] = useState<SharePermission>("use");
  const [error, setError] = useState<string | null>(null);

  const [members, teams] = people.data ?? [[], []];
  const choices =
    principalType === "user"
      ? members.map((m) => ({ id: m.id, label: `${m.name} · ${m.email}` }))
      : teams.map((team) => ({ id: team.id, label: team.name }));

  const grant = async () => {
    setError(
      await attempt(() =>
        teamApi.share(type, id, {
          principal_type: principalType,
          ...(principalType === "org" ? {} : { principal_id: principalId }),
          permission,
        }),
      ),
    );
    shares.reload();
  };
  const revoke = async (shareId: string) => {
    setError(await attempt(() => teamApi.unshare(type, id, shareId)));
    shares.reload();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team.sharing.dialogTitle", { name })}</DialogTitle>
          <DialogDescription>{t(`team.permission.${permission}Hint`)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="share-with">{t("team.sharing.with")}</Label>
              <NativeSelect
                id="share-with"
                value={principalType}
                onChange={(event) => {
                  setPrincipalType(event.target.value as PrincipalType);
                  setPrincipalId("");
                }}
              >
                <NativeSelectOption value="org">{t("team.sharing.everyone")}</NativeSelectOption>
                <NativeSelectOption value="team">{t("team.sharing.team")}</NativeSelectOption>
                <NativeSelectOption value="user">{t("team.sharing.member")}</NativeSelectOption>
              </NativeSelect>
            </div>
            {principalType === "org" ? null : (
              <NativeSelect
                aria-label={t(`team.sharing.${principalType === "user" ? "member" : "team"}`)}
                value={principalId}
                onChange={(event) => setPrincipalId(event.target.value)}
              >
                <NativeSelectOption value="">{t("team.sharing.pick")}</NativeSelectOption>
                {choices.map((choice) => (
                  <NativeSelectOption key={choice.id} value={choice.id}>
                    {choice.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <NativeSelect
              aria-label={t("team.org.role")}
              value={permission}
              onChange={(event) => setPermission(event.target.value as SharePermission)}
            >
              {ladderFor(type).map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {t(`team.permission.${level}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              disabled={principalType !== "org" && !principalId}
              onClick={() => void grant()}
            >
              {t("team.sharing.share")}
            </Button>
          </div>
          <ErrorLine message={error ?? shares.error} />

          <div className="flex flex-col gap-2">
            <Label>{t("team.sharing.current")}</Label>
            {shares.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("team.sharing.notShared")}</p>
            ) : null}
            {shares.data?.map((share) => (
              <div
                key={share.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span>
                  {share.principal_type === "org"
                    ? t("team.sharing.everyone")
                    : (share.principal_name ?? share.principal_id)}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">{t(`team.permission.${share.permission}`)}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => void revoke(share.id)}>
                    {t("team.common.remove")}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
