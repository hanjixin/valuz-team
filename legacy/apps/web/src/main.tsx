import { initI18n } from "@valuz/shared/i18n";
import { AppToaster, TooltipProvider } from "@valuz/ui";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { get, getTokens, onAuthChange, post, setTokens } from "./api.ts";
import { Notifications } from "./notifications.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { AuthPage } from "./pages/Auth.tsx";
import { DevicesPage } from "./pages/Devices.tsx";
import { LibraryPage } from "./pages/Library.tsx";
import { ProjectPage, ProjectsPage } from "./pages/Projects.tsx";
import { SessionPage, SessionsPage } from "./pages/Session.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { TaskPage } from "./pages/Task.tsx";
import { TeamPage } from "./pages/Team.tsx";
import "./styles.css";
import { Btn } from "./ui.tsx";

export interface Me {
  user: { id: string; name: string; email: string };
  orgs: { id: string; name: string; role: string }[];
  current_org_id: string;
  role: string;
}

const NAV: [string, string][] = [
  ["/projects", "项目"], ["/sessions", "会话"], ["/agents", "智能体"], ["/library", "资源库"],
  ["/devices", "设备"], ["/team", "团队"], ["/settings", "设置"],
];

function Shell({ me }: { me: Me }) {
  const org = me.orgs.find((o) => o.id === me.current_org_id);
  const switchOrg = (orgId: string) => {
    const t = getTokens();
    if (t) setTokens({ ...t, orgId });
    window.location.hash = "#/projects";
    window.location.reload();
  };
  const logout = async () => {
    const t = getTokens();
    if (t) await post("/v1/auth/logout", { refresh_token: t.refresh }).catch(() => undefined);
    setTokens(null);
  };
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Agent Base</div>
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>{label}</NavLink>
        ))}
        <Notifications />
        <div className="foot">
          {me.orgs.length > 1 ? (
            <select value={me.current_org_id} onChange={(e) => switchOrg(e.target.value)} aria-label="切换组织">
              {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ) : (
            <span>{org?.name}</span>
          )}
          <span>{me.user.name} · {me.role}</span>
          <Btn className="ghost" onClick={() => void logout()}>退出登录</Btn>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:id" element={<SessionPage me={me} />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/devices" element={<DevicesPage me={me} />} />
          <Route path="/team" element={<TeamPage me={me} />} />
          <Route path="/settings" element={<SettingsPage me={me} />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(() => getTokens() !== null);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => onAuthChange(() => setSignedIn(getTokens() !== null)), []);
  useEffect(() => {
    if (!signedIn) return setMe(null);
    get<Me>("/v1/me").then(setMe, () => setTokens(null));
  }, [signedIn]);
  if (!signedIn) return <AuthPage />;
  if (!me) return <div className="auth muted">加载中…</div>;
  return <Shell me={me} />;
}

initI18n({ locale: "zh-CN", fallbackLocale: "en-US" });

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <HashRouter>
      <TooltipProvider>
        <App />
        <AppToaster />
      </TooltipProvider>
    </HashRouter>
  </StrictMode>,
);
