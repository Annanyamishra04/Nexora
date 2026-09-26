import { describe, expect, it } from "vitest";
import { getMessageActions, type MessageActionContext } from "@/lib/chat/message-actions";

const base: MessageActionContext = {
  id: "11111111-1111-4111-8111-111111111111",
  role: "assistant",
  status: "complete",
  content: "hello",
  isLast: true,
  isBusy: false,
  hasSources: false,
  isEditing: false,
};
const ids = (c: Partial<MessageActionContext>) => getMessageActions({ ...base, ...c }).map((a) => a.id);

describe("getMessageActions", () => {
  it("assistant: copy + regenerate on the latest reply", () => {
    expect(ids({})).toEqual(["copy", "regenerate"]);
  });
  it("assistant: no regenerate on older replies", () => {
    expect(ids({ isLast: false })).toEqual(["copy"]);
  });
  it("assistant: sources only when available", () => {
    expect(ids({ hasSources: true })).toEqual(["copy", "regenerate", "sources"]);
  });
  it("user: copy + edit, never regenerate", () => {
    expect(ids({ role: "user", isLast: true })).toEqual(["copy", "edit"]);
  });
  it("shows NO actions on a message that is still streaming", () => {
    expect(ids({ status: "streaming" })).toEqual([]);
  });
  it("disables (not hides) conflicting actions while another reply is generating", () => {
    const actions = getMessageActions({ ...base, isBusy: true });
    expect(actions.find((a) => a.id === "regenerate")?.disabled).toBe(true);
    expect(actions.find((a) => a.id === "copy")?.disabled).toBe(false);
    const user = getMessageActions({ ...base, role: "user", isBusy: true });
    expect(user.find((a) => a.id === "edit")?.disabled).toBe(true);
  });
  it("hides edit/regenerate for messages that aren't saved yet (temp ids)", () => {
    expect(ids({ role: "user", id: "tmp-123-1" })).toEqual(["copy"]);
    expect(ids({ id: "tmp-123-2" })).toEqual(["copy"]);
  });
  it("offers regenerate on an interrupted latest reply", () => {
    expect(ids({ status: "incomplete" })).toEqual(["copy", "regenerate"]);
  });
  it("hides copy for empty content and all actions while editing", () => {
    expect(ids({ content: "  " })).toEqual(["regenerate"]);
    expect(ids({ role: "user", isEditing: true })).toEqual([]);
  });
});
