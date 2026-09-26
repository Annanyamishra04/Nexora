import { describe, expect, it } from "vitest";
import { consumeChatStream, parseStreamLine } from "@/lib/chat/stream";

function streamOf(parts: (string | Error)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[i++];
      if (part === undefined) return controller.close();
      if (part instanceof Error) return controller.error(part);
      controller.enqueue(enc.encode(part));
    },
  });
}
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe("parseStreamLine", () => {
  it("returns null for blank, malformed, or unknown events", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("{not json")).toBeNull();
    expect(parseStreamLine('"str"')).toBeNull();
    expect(parseStreamLine('{"type":"mystery"}')).toBeNull();
    expect(parseStreamLine('{"type":"chunk"}')).toBeNull();
    expect(parseStreamLine('{"type":"done"}')).toBeNull();
  });
  it("parses valid events and defaults error fields safely", () => {
    expect(parseStreamLine('{"type":"chunk","text":"hi"}')).toEqual({ type: "chunk", text: "hi" });
    expect(parseStreamLine('{"type":"error"}')).toMatchObject({ type: "error", partial: false });
    expect(parseStreamLine('{"type":"done","messageId":"m","notice":"retrieval_failed"}')).toMatchObject({ notice: "retrieval_failed" });
  });
});

describe("consumeChatStream", () => {
  it("collects chunks and the done event", async () => {
    const got: string[] = [];
    const out = await consumeChatStream(
      streamOf([line({ type: "chunk", text: "He" }), line({ type: "chunk", text: "llo" }), line({ type: "done", messageId: "m1" })]),
      { onChunk: (t) => got.push(t) }
    );
    expect(got.join("")).toBe("Hello");
    expect(out.status).toBe("done");
    expect(out.done?.messageId).toBe("m1");
  });

  it("handles events split across network reads and a final line without newline", async () => {
    const got: string[] = [];
    const whole = line({ type: "chunk", text: "abc" }) + JSON.stringify({ type: "done", messageId: "m" });
    const out = await consumeChatStream(streamOf([whole.slice(0, 7), whole.slice(7, 30), whole.slice(30)]), { onChunk: (t) => got.push(t) });
    expect(got).toEqual(["abc"]);
    expect(out.status).toBe("done");
  });

  it("skips malformed lines but keeps the good ones", async () => {
    const got: string[] = [];
    const out = await consumeChatStream(
      streamOf([line({ type: "chunk", text: "a" }), "garbage\n", '{"type":"chunk"}\n', line({ type: "done", messageId: "m" })]),
      { onChunk: (t) => got.push(t) }
    );
    expect(got).toEqual(["a"]);
    expect(out.malformedCount).toBe(2);
    expect(out.status).toBe("done");
  });

  it("reports a stream that ends with no terminal event as interrupted, not complete", async () => {
    const got: string[] = [];
    const out = await consumeChatStream(streamOf([line({ type: "chunk", text: "partial" })]), { onChunk: (t) => got.push(t) });
    expect(got).toEqual(["partial"]);
    expect(out.status).toBe("interrupted");
  });

  it("reports a dropped connection as interrupted (readFailed) and keeps received text", async () => {
    const got: string[] = [];
    const out = await consumeChatStream(streamOf([line({ type: "chunk", text: "abc" }), new TypeError("network error")]), {
      onChunk: (t) => got.push(t),
    });
    expect(got).toEqual(["abc"]);
    expect(out).toMatchObject({ status: "interrupted", readFailed: true });
  });

  it("surfaces server error events with their code", async () => {
    const out = await consumeChatStream(
      streamOf([line({ type: "chunk", text: "x" }), line({ type: "error", code: "rate_limited", message: "slow", partial: true, messageId: "m9" })]),
      { onChunk: () => {} }
    );
    expect(out.status).toBe("error");
    expect(out.error).toMatchObject({ code: "rate_limited", partial: true, messageId: "m9" });
  });

  it("rethrows aborts so callers can distinguish Stop/navigation", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(consumeChatStream(streamOf([abort]), { onChunk: () => {} })).rejects.toThrow("aborted");
  });

  it("calls onActivity for each read (stall watchdog hook)", async () => {
    let n = 0;
    await consumeChatStream(streamOf([line({ type: "chunk", text: "a" }), line({ type: "done", messageId: "m" })]), {
      onChunk: () => {},
      onActivity: () => n++,
    });
    expect(n).toBe(2);
  });
});
