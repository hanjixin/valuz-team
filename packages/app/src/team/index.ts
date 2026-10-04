/**
 * Collaboration UI (agent-base addition — see UPSTREAM.md): three settings
 * sections contributed through the edition plugin mechanism, so no upstream
 * page is edited to make room for them.
 */
import { registerPlugin } from "@valuz/core";
import { DevicesSection } from "./DevicesSection";
import { OrganizationSection } from "./OrganizationSection";
import { SharingSection } from "./SharingSection";

const group = { id: "team", label: "team.nav.group" };

export const registerTeamPlugin = (): Promise<unknown> =>
  registerPlugin({
    id: "agent-base.team",
    version: "0.1.0",
    settingsSections: [
      {
        id: "team-org",
        label: "team.nav.org.label",
        description: "team.nav.org.desc",
        icon: "radio",
        group,
        component: OrganizationSection,
        edition: "personal",
      },
      {
        id: "team-devices",
        label: "team.nav.devices.label",
        description: "team.nav.devices.desc",
        icon: "hard-drive",
        group,
        component: DevicesSection,
        edition: "personal",
      },
      {
        id: "team-sharing",
        label: "team.nav.sharing.label",
        description: "team.nav.sharing.desc",
        icon: "globe",
        group,
        component: SharingSection,
        edition: "personal",
      },
    ],
  });
