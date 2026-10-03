import { type FormEvent, useState } from "react";
import { post, setTokens } from "../api.ts";
import { Btn, ErrorLine, Field, useAction } from "../ui.tsx";

export function AuthPage() {
  // An invite link looks like  #/?invite=inv_…  and opens straight on registration.
  const invite = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("invite") ?? "";
  const [mode, setMode] = useState<"login" | "register">(invite ? "register" : "login");
  const [form, setForm] = useState({ email: "", password: "", name: "", invite });
  const action = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const res =
        mode === "login"
          ? await post("/v1/auth/login", { email: form.email, password: form.password })
          : await post("/v1/auth/register", {
              email: form.email, password: form.password, name: form.name, ...(form.invite ? { invite_token: form.invite } : {}),
            });
      // Login does not name an org; ask which one the account lands in before signing in.
      let orgId: string = res.org_id ?? "";
      if (!orgId) {
        const me = await fetch("/v1/me", { headers: { authorization: `Bearer ${res.access_token}` } });
        if (!me.ok) throw new Error("这个账号目前不属于任何组织，请向管理员索取邀请。");
        orgId = (await me.json()).current_org_id;
      }
      setTokens({ access: res.access_token, refresh: res.refresh_token, orgId });
    });
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <h1>Agent Base</h1>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>登录</button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>注册</button>
        </div>
        {mode === "register" ? <Field label="姓名"><input required value={form.name} onChange={set("name")} autoComplete="name" /></Field> : null}
        <Field label="邮箱"><input required type="email" value={form.email} onChange={set("email")} autoComplete="email" /></Field>
        <Field label="密码" hint={mode === "register" ? "至少 8 位" : undefined}>
          <input required type="password" minLength={8} value={form.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </Field>
        {mode === "register" ? (
          <Field label="邀请码（可选）" hint="有邀请码则加入对方的组织，否则创建你自己的组织">
            <input value={form.invite} onChange={set("invite")} placeholder="inv_…" />
          </Field>
        ) : null}
        <ErrorLine>{action.error}</ErrorLine>
        <Btn type="submit" className="primary" disabled={action.busy}>{mode === "login" ? "登录" : "创建账号"}</Btn>
      </form>
    </div>
  );
}
