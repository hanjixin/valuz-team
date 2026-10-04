/**
 * Key for the layout's page-transition wrapper around the ``<Outlet/>``.
 *
 * A changed key remounts the routed page and replays the enter animation —
 * right for genuine page changes, wrong for the conversation family.
 * ConversationPage handles every ``/conversation/*`` transition in place:
 * the ``/conversation/new`` → ``/conversation/{id}`` promotion relies on
 * refs surviving the navigate (send-in-flight fast-path, optimistic
 * message, the live SSE subscription), and true session switches are
 * handled internally via ``conversationInstanceKey`` + the
 * bootstrap/refreshEvents machinery. Keying on the raw pathname remounted
 * the whole page on every one of those navigations, resetting all of that
 * state mid-send.
 */
export const outletTransitionKey = (pathname: string): string =>
  pathname.startsWith("/conversation") ? "/conversation" : pathname;
