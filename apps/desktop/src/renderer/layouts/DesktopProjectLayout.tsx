import type { CSSProperties } from "react";
import { ProjectLayoutBase } from "@valuz/app/layout";
import { AccountMenu } from "@valuz/app/team";
import { assetUrl } from "@valuz/shared";

export type { ProjectOutletContext } from "@valuz/app/layout";
export { useProjectOutlet } from "@valuz/app/layout";

const logoMenuContentStyle = {
  WebkitAppRegion: "no-drag",
} as CSSProperties;

export const DesktopProjectLayout = () => (
  <ProjectLayoutBase
    logoSrc={assetUrl("logo.png")}
    logoMenuContentStyle={logoMenuContentStyle}
    directoryFieldMode="picker"
    // agent-base: who is signed in, and in which organization — bottom left.
    sidebarFooter={<AccountMenu />}
  />
);
