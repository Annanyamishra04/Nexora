import { isPersistedId } from "@/lib/chat/request";

export type MessageActionId = "copy" | "edit" | "regenerate" | "sources";

export interface MessageActionState {
  id: MessageActionId;
  /** Shown but not clickable — e.g. Edit while another reply is generating. */
  disabled: boolean;
}

export interface MessageActionContext {
  id: string;
  role: "user" | "assistant";
  status: "complete" | "incomplete" | "streaming";
  content: string;
  /** True for the final message in the conversation. */
  isLast: boolean;
  /** True while *any* reply in this conversation is being generated. */
  isBusy: boolean;
  hasSources: boolean;
  isEditing: boolean;
}

/**
 * Single source of truth for which actions a message shows.
 *
 *  - A message that is itself still streaming shows NO actions, so a
 *    half-written reply can't be copied/regenerated and buttons never
 *    duplicate while text is arriving.
 *  - Edit: only the person's own messages, only once saved (a not-yet-
 *    persisted message has no server id to edit).
 *  - Regenerate: only the *latest* assistant message (the server enforces
 *    the same rule), including an interrupted one.
 *  - Edit/Regenerate are shown but disabled while anything is generating,
 *    so layout doesn't jump and the reason is discoverable.
 */
export function getMessageActions(message: MessageActionContext): MessageActionState[] {
  if (message.status === "streaming" || message.isEditing) return [];

  const actions: MessageActionState[] = [];

  if (message.content.trim().length > 0) {
    actions.push({ id: "copy", disabled: false });
  }

  const persisted = isPersistedId(message.id);

  if (message.role === "user" && persisted) {
    actions.push({ id: "edit", disabled: message.isBusy });
  }

  if (message.role === "assistant" && message.isLast && persisted) {
    actions.push({ id: "regenerate", disabled: message.isBusy });
  }

  if (message.role === "assistant" && message.hasSources) {
    actions.push({ id: "sources", disabled: false });
  }

  return actions;
}
