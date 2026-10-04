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
  marketplace: true,
  playbooks: true,
  /** The automation template library (it is filled from the marketplace). */
  automationTemplates: true,
  /** Settings sections with no server behind them. */
  settingsSections: ["browser", "parsing", "backup"],
};
