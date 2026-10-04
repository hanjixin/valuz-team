// Helpers for reconnecting an already-installed connector that isn't currently
// connected (the "Connect" button on the Connectors page).
//
// The flow is test-first: a re-probe (`POST /connectors/{id}/test`) now
// self-heals an expired OAuth token server-side — it refreshes with the stored
// refresh_token and retries before reporting failure. So we always test first;
// only when that comes back not-ok do OAuth connectors fall back to a full
// re-authorization (browser re-consent), which is the one thing a silent
// refresh can't cover (no/again-expired refresh token, revoked grant, changed
// scopes). Non-OAuth connectors have no token to refresh, so a failed test is
// just surfaced as an error.

import type { ConnectorItem, CreateConnectorRequest } from "@valuz/core";

// Whether a failed re-probe should escalate to full re-authorization.
export function shouldReauthorize(connector: ConnectorItem): boolean {
  return connector.auth_type === "oauth";
}

// Build the create payload that re-runs the OAuth authorization flow for an
// existing connector. Mirrors the field-less catalog connect payload: the
// backend keys off the slug to reuse the saved OAuth client + metadata, so no
// credentials need to be re-entered for re-consent.
export function reauthorizePayload(
  connector: ConnectorItem,
): CreateConnectorRequest {
  return {
    slug: connector.slug,
    display_name: connector.display_name,
    transport: connector.transport || "http",
    url: connector.url ?? "",
    auth_type: "oauth",
    description: connector.description,
    connector_type: connector.connector_type,
  };
}
