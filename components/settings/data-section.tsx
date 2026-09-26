"use client";

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { deleteAllMyData, type DeleteDataState } from "@/app/(app)/settings/actions";

/**
 * Explains what's stored and offers a real (not decorative) way to
 * delete it — everything here actually works, per the phase brief's
 * "do not create fake settings" requirement. What's deleted is
 * conversations + documents, not the auth account itself; see the
 * comment above `deleteAllMyData` in actions.ts for why account
 * deletion isn't included.
 */
export function DataSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<DeleteDataState | null>(null);

  function confirmDeleteAll() {
    const formData = new FormData();
    formData.set("confirm", "DELETE");
    startTransition(async () => {
      const state = await deleteAllMyData({ error: null, success: false }, formData);
      setResult(state);
      if (state.success) setConfirmOpen(false);
    });
  }

  return (
    <section className="card-surface p-5">
      <h2 className="mb-1 text-base font-medium text-ink">Data</h2>
      <p className="mb-4 text-sm text-ink-muted">
        Nexora stores your conversations and messages, and the text extracted from documents
        you upload (chunked and embedded for search) — never the AI provider&apos;s own logs, since
        requests to Gemini don&apos;t retain your data beyond generating a response. Deleting a
        conversation or document elsewhere in the app removes it immediately; nothing is kept
        after that beyond standard database backups.
      </p>

      <div className="rounded border border-danger-50 bg-danger-50/40 p-4">
        <h3 className="text-sm font-medium text-ink">Delete all my data</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Permanently deletes every conversation, message, and uploaded document on your account.
          This does not delete your account or sign-in — you&apos;ll stay signed in with an empty
          workspace. This can&apos;t be undone.
        </p>
        <Button
          type="button"
          variant="danger"
          size="sm"
          className="mt-3"
          onClick={() => {
            setResult(null);
            setConfirmOpen(true);
          }}
        >
          Delete all my data
        </Button>

        {result?.error && (
          <p role="alert" className="mt-2 text-sm text-danger-500">
            {result.error}
          </p>
        )}
        {result?.success && (
          <p role="status" className="mt-2 text-sm text-moss-600">
            Deleted {result.deletedConversations ?? 0} conversation
            {result.deletedConversations === 1 ? "" : "s"} and {result.deletedDocuments ?? 0}{" "}
            document
            {result.deletedDocuments === 1 ? "" : "s"}.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete all your data?"
        description="Every conversation, message, and uploaded document on your account will be permanently deleted. Your account stays signed in. This can't be undone."
        confirmLabel="Delete everything"
        pending={pending}
        onConfirm={confirmDeleteAll}
        onCancel={() => !pending && setConfirmOpen(false)}
      />
    </section>
  );
}
