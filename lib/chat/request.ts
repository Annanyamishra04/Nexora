import { ChatRequestError } from "@/lib/chat/error-state";

/** Everything the chat UI can ask /api/chat to do. */
export type ChatAction =
  | { kind: "send"; content: string; documentId?: string }
  | { kind: "retry"; messageId: string }
  | { kind: "regenerate"; messageId: string }
  | { kind: "edit"; messageId: string; content: string };

/** Builds the JSON body for POST /api/chat. Matches chatRequestSchema (lib/validation/chat.ts). */
export function buildChatRequestBody(
  conversationId: string | null,
  action: ChatAction
): Record<string, string> {
  const body: Record<string, string> = {};
  if (conversationId) body.conversationId = conversationId;

  switch (action.kind) {
    case "send":
      body.content = action.content;
      if (action.documentId) body.documentId = action.documentId;
      break;
    case "retry":
      body.retryMessageId = action.messageId;
      break;
    case "regenerate":
      body.regenerateMessageId = action.messageId;
      break;
    case "edit":
      body.editMessageId = action.messageId;
      body.content = action.content;
      break;
  }
  return body;
}

/** Converts a non-2xx response into a ChatRequestError carrying the server's safe message + code. */
export async function toRequestError(res: Response): Promise<ChatRequestError> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new ChatRequestError(typeof data.error === "string" ? data.error : "", {
    code: typeof data.code === "string" ? data.code : undefined,
    status: res.status,
  });
}

/** Ids for messages that exist only in the browser so far. Never sent to the server as targets. */
export const TEMP_ID_PREFIX = "tmp-";

let tempCounter = 0;
export function makeTempId(): string {
  tempCounter += 1;
  return `${TEMP_ID_PREFIX}${Date.now()}-${tempCounter}`;
}

export function isPersistedId(id: string): boolean {
  return !id.startsWith(TEMP_ID_PREFIX);
}
