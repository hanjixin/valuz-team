/**
 * agent-base: parts of the upstream app this server does not provide (see
 * UPSTREAM.md). Pages consult it to leave the entry points out, rather than
 * showing a door that opens on an error. (Upstream's own tests of those pages
 * switch the entries back on.)
 */
export const UNAVAILABLE: {
  plugins: boolean;
  marketplace: boolean;
  playbooks: boolean;
  automationTemplates: boolean;
  settingsSections: readonly string[];
} = {
  /** Plugin bundles. Skills and connectors, which share the page, are provided. */
  plugins: true,
  /** The marketplace is provided (skills, connectors, agents, teams) — without its plugin bundles. */
  marketplace: false,
  playbooks: true,
  /** The automation template library, filled from the marketplace. */
  automationTemplates: false,
  /** Settings sections with no server behind them. */
  settingsSections: ["browser", "parsing", "backup"],
};
