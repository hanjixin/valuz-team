import type { ReactNode } from "react";
import {
  ConversationLocalFileLinkOverrideContext,
  type ConversationLocalFileLinkOverride,
} from "./use-conversation-local-file-links";

export function ConversationLocalFileLinkProvider({
  value,
  children,
}: {
  value: ConversationLocalFileLinkOverride;
  children: ReactNode;
}) {
  return (
    <ConversationLocalFileLinkOverrideContext.Provider value={value}>
      {children}
    </ConversationLocalFileLinkOverrideContext.Provider>
  );
}
