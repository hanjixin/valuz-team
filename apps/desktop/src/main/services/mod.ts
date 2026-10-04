import type { CraftServerInfo, ServiceInfo } from "@valuz/shared";
import type { ServiceDescriptor } from "@valuz/core";
import type {
  EgressBootstrap,
  EgressDiagnosticEvent,
  EgressManagerStatus,
  EgressMode,
  EgressSnapshot,
  RuntimePhaseRecord,
} from "@valuz/desktop-network-egress/contracts";
import { tmpdir } from "node:os";
import type { DescriptorRegistry } from "./descriptors";
import { createTeamServiceManager } from "./team";

export interface DesktopServiceManager {
  descriptors: DescriptorRegistry;
  startAllServices(): Promise<ServiceInfo[]>;
  stopAllServices(): Promise<ServiceInfo[]>;
  restartService(name: string): Promise<ServiceInfo[]>;
  getLogs(name: string): string[];
  getAgentServerInfo(): CraftServerInfo;
  getDesktopControlToken(): string;
  getShellStatus(): { ready: boolean };
  getAllStatus(): ServiceInfo[];
  registerDescriptor(descriptor: ServiceDescriptor): ServiceDescriptor;
  unregisterDescriptor(name: string): boolean;
  getEgressDiagnostics(): EgressDiagnosticEvent[];
  getEgressSnapshots(): EgressSnapshot[];
  getEgressMode(): EgressMode;
  getEgressStatus(): EgressManagerStatus;
  getEgressRuntimePhases(): RuntimePhaseRecord[];
  getEgressBootstrap?(): EgressBootstrap | null;
  setEgressMode(mode: EgressMode): Promise<EgressManagerStatus>;
}

/**
 * agent-base: the services behind the desktop. The Python sidecar this used to
 * start is gone; see `./team.ts` for what runs in its place.
 */
export const createServiceManager = (
  appDataDir = tmpdir(),
  options?: Parameters<typeof createTeamServiceManager>[1],
) => createTeamServiceManager(appDataDir, options);
