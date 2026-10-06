import { useEffect, useMemo, useRef, useState } from "react";
import { createTransport, providersApi } from "@valuz/core";
import { ErrorBoundary, LogoShimmer } from "@valuz/ui";
import { AuthGate } from "@valuz/app/auth";
import { ConnectScreen } from "./components/ConnectScreen";
import { StartupScreen } from "./components/StartupScreen";
import { UpdaterListener } from "./components/UpdaterListener";
import { UpdateToast } from "./components/UpdateToast";
import { useDesktopStartup } from "./hooks/use-desktop-startup";
import { ElectronPlatformProvider } from "./lib/electron-platform";
import { AppRouter } from "./routes/router";
import { isOnboarded } from "@valuz/app/lib/onboarding";
import "./App.css";

const hasUsableProvider = (
  providers: { enabled: boolean; credential_source: string }[],
) => providers.some((p) => p.enabled && p.credential_source !== "none");

/**
 * Once signed in: a member with no usable model channel is sent to the welcome
 * flow first. (Asked after signing in — the server answers nobody else.)
 */
const SignedIn = () => {
  const [setupChecked, setSetupChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (isOnboarded()) {
        if (!cancelled) setSetupChecked(true);
        return;
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        if (cancelled) return;

        try {
          const { providers } = await providersApi.list();
          if (cancelled) return;
          if (!hasUsableProvider(providers)) {
            window.location.hash = "#/welcome";
          }
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      if (!cancelled) setSetupChecked(true);
    };

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!setupChecked) {
    return (
      <div className="flex h-screen items-center justify-center">
        <LogoShimmer size="md" />
      </div>
    );
  }
  return (
    <>
      <UpdaterListener />
      <UpdateToast />
      <AppRouter />
    </>
  );
};

/** With a server chosen: wait for the connection, then for the member to sign in. */
const Connected = () => {
  const { services, logs, loading, checking, ready, error, retry } =
    useDesktopStartup();

  // Once the splash has shown, keep it mounted until its exit animation
  // finishes, instead of cutting straight to the app.
  const [splashDone, setSplashDone] = useState(false);
  const sawBootRef = useRef(false);
  if (!checking && !ready) sawBootRef.current = true;
  const holdSplash = ready && sawBootRef.current && !splashDone;

  if (!checking && (!ready || holdSplash)) {
    return (
      <StartupScreen
        services={services}
        logs={logs}
        loading={loading}
        error={error}
        onRetry={retry}
        complete={ready}
        onComplete={() => setSplashDone(true)}
      />
    );
  }
  if (checking) {
    return (
      <div className="flex h-screen items-center justify-center">
        <LogoShimmer size="md" />
      </div>
    );
  }
  return (
    <AuthGate>
      <SignedIn />
    </AuthGate>
  );
};

export const App = () => {
  // agent-base: the desktop belongs to a team server; a new one asks which.
  // `undefined`: asking; `null`: none chosen yet; a string: connected to it.
  const [server, setServer] = useState<string | null | undefined>(undefined);
  const transport = useMemo(() => createTransport(), []);
  useEffect(() => {
    // Outside the desktop shell (the renderer's own tests) there is nobody to ask.
    if (!("valuzDesktop" in window)) return setServer("");
    void transport
      .invoke<{ server_url: string } | undefined>("team_connection")
      // No answer at all is not "no server": let the startup flow report what is wrong.
      .then((connection) => setServer(connection ? connection.server_url || null : ""))
      .catch(() => setServer(""));
  }, [transport]);

  // Asked for from the sign-in page: which server instead of this one. Only there — a signed-in
  // session belongs to the server it was made on.
  const [previous, setPrevious] = useState<string | null>(null);
  useEffect(() => {
    const change = () =>
      setServer((now) => {
        if (typeof now === "string" && now) setPrevious(now);
        return null;
      });
    window.addEventListener("agent-base:change-server", change);
    return () => window.removeEventListener("agent-base:change-server", change);
  }, []);

  let content;
  if (server === undefined) {
    content = (
      <div className="flex h-screen items-center justify-center">
        <LogoShimmer size="md" />
      </div>
    );
  } else if (server === null) {
    content = (
      <ConnectScreen
        current={previous ?? ""}
        onCancel={previous ? () => setServer(previous) : undefined}
        onConnect={async (url) => {
          const connection = await transport.invoke<{ server_url: string }>(
            "team_set_server_url",
            { url },
          );
          setPrevious(null);
          setServer(connection.server_url);
        }}
      />
    );
  } else {
    content = <Connected />;
  }

  return (
    <ElectronPlatformProvider>
      <ErrorBoundary>{content}</ErrorBoundary>
    </ElectronPlatformProvider>
  );
};
