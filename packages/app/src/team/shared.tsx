/** Small pieces the collaboration sections share. (agent-base addition — see UPSTREAM.md.) */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@valuz/ui";

/** Load something once, and again on `reload()`. Errors are kept as a message to show. */
export function useLoaded<T>(load: () => Promise<T>): {
  data: T | null;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // `load` is recreated every render; the tick is what asks for a new fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, [tick]);
  useEffect(() => {
    let cancelled = false;
    run().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [run]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

/** Run an action; return its error message instead of throwing. */
export async function attempt(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

export const ErrorLine = ({ message }: { message: string | null }) =>
  message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
