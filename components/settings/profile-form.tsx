"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { updateDisplayName, type ProfileActionState } from "@/app/(app)/settings/actions";

const initialState: ProfileActionState = { error: null, success: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function ProfileForm({ initialDisplayName }: { initialDisplayName: string | null }) {
  const [state, formAction] = useFormState(updateDisplayName, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <Label htmlFor="display_name">Display name</Label>
        <Input
          id="display_name"
          name="display_name"
          defaultValue={initialDisplayName ?? ""}
          placeholder="How should we address you?"
          maxLength={80}
        />
        <FieldError>{state.error}</FieldError>
        {state.success && (
          <p role="status" className="mt-1.5 text-sm text-moss-600">
            Saved.
          </p>
        )}
      </div>
      <SaveButton />
    </form>
  );
}
