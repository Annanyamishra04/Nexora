import type { ChatError } from "@/lib/chat/errors";

/** Standard JSON error body for route handlers: a safe message plus a machine-readable code. Never a stack trace or provider payload. */
export function errorResponse(error: ChatError): Response {
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}
