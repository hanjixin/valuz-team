import { ProjectLayoutBase } from "@valuz/app/layout";
import { AccountMenu } from "@valuz/app/team";

export function WebProjectLayout() {
  return (
    <ProjectLayoutBase
      logoSrc="/logo.png"
      directoryFieldMode="picker"
      // agent-base: who is signed in, and in which organization — bottom left.
      sidebarFooter={<AccountMenu />}
    />
  );
}
