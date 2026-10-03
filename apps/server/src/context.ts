import type { OrgRole } from "@agent-base/protocol";
import type { AutomationService } from "./automations.ts";
import type { ChannelService } from "./channels.ts";
import type { Config } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { DocumentService } from "./documents.ts";
import type { DeviceHub } from "./device-hub.ts";
import type { PubSub } from "./pubsub.ts";
import type { StorageService } from "./storage.ts";
import type { TaskService } from "./tasks/service.ts";

export interface Auth {
  userId: string;
  name: string;
  orgId: string;
  role: OrgRole;
}

export interface Ctx {
  config: Config;
  db: Db;
  pubsub: PubSub;
  box: SecretBox;
  hub: DeviceHub;
  storage: StorageService;
  tasks: TaskService;
  automations: AutomationService;
  documents: DocumentService;
  channels: ChannelService;
  /** Tell a person something happened (stored, and pushed to their open clients). */
  notify(userId: string, orgId: string, notice: { kind: string; title: string; body?: string; link?: string }): Promise<void>;
  instanceId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every non-public route. */
    auth: Auth;
  }
}

export const isOrgAdmin = (auth: Auth): boolean => auth.role === "owner" || auth.role === "admin";
