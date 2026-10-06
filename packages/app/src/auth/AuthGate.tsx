/**
 * Shows the sign-in page until there is a session (agent-base addition — the
 * server is multi-user). Everything below it can assume a signed-in user.
 */
import { type FormEvent, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { authApi, getAuthSession, subscribeAuthSession } from "@valuz/core";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Tabs, TabsList, TabsTrigger, useI18n } from "@valuz/ui";
import { enterAccount, serverOfThisDesktop } from "../team/ThisComputer";

export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeAuthSession, getAuthSession, getAuthSession);
  const signedIn = Boolean(session?.access_token);
  const orgId = session?.org_id ?? "";
  // In the desktop app, signing in is enough to run agents: this computer is linked without being asked —
  // for this member, in the organization they are acting in, and again when they move to another.
  useEffect(() => {
    if (!signedIn) return;
    void authApi.me().then(
      (me) => enterAccount(getAuthSession()?.access_token ?? "", orgId || me.current_org_id, me.user.id),
      () => undefined,
    );
  }, [signedIn, orgId]);
  return session ? <>{children}</> : <SignInPage />;
}

function SignInPage() {
  const { t } = useI18n();
  // An invite link looks like  …/#/?invite=inv_…  and opens straight on registration.
  const invite = new URLSearchParams(window.location.hash.split("?")[1] ?? window.location.search).get("invite") ?? "";
  const [mode, setMode] = useState<"signIn" | "register">(invite ? "register" : "signIn");
  const [form, setForm] = useState({ email: "", password: "", name: "", invite });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  // In the desktop app: which server this is, and the way to another.
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    void serverOfThisDesktop().then(setServer);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signIn") await authApi.login(form.email, form.password);
      else await authApi.register({ email: form.email, password: form.password, name: form.name, ...(form.invite ? { invite_token: form.invite } : {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Agent Base</CardTitle>
          <CardDescription>{t("auth.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            <Tabs value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
              <TabsList className="w-full">
                <TabsTrigger value="signIn" className="flex-1">{t("auth.signIn")}</TabsTrigger>
                <TabsTrigger value="register" className="flex-1">{t("auth.register")}</TabsTrigger>
              </TabsList>
            </Tabs>
            {mode === "register" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="auth-name">{t("auth.name")}</Label>
                <Input id="auth-name" required autoComplete="name" value={form.name} onChange={set("name")} />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-email">{t("auth.email")}</Label>
              <Input id="auth-email" type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-password">{t("auth.password")}</Label>
              <Input
                id="auth-password"
                type="password"
                required
                minLength={mode === "register" ? 8 : 1}
                autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                value={form.password}
                onChange={set("password")}
              />
              {mode === "register" ? <p className="text-xs text-muted-foreground">{t("auth.passwordHint")}</p> : null}
            </div>
            {mode === "register" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="auth-invite">{t("auth.inviteToken")}</Label>
                <Input id="auth-invite" value={form.invite} onChange={set("invite")} placeholder="inv_…" />
                <p className="text-xs text-muted-foreground">{t("auth.inviteHint")}</p>
              </div>
            ) : null}
            {error ? <p role="alert" className="text-sm text-error-text">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              {mode === "signIn" ? t("auth.submitSignIn") : t("auth.submitRegister")}
            </Button>
          </form>
          {server ? (
            <p className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground" data-testid="auth-server">
              <span className="min-w-0 truncate">
                {t("auth.server")} {server}
              </span>
              <button
                type="button"
                className="shrink-0 underline underline-offset-2 hover:text-foreground"
                onClick={() => window.dispatchEvent(new CustomEvent("agent-base:change-server"))}
              >
                {t("auth.changeServer")}
              </button>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
