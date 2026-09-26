"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import type { AuthActionState } from "@/app/(auth)/actions";

const initialState: AuthActionState = { error: null, info: null };

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

export function AuthForm({
  mode,
  action,
}: {
  mode: "login" | "signup";
  action: (state: AuthActionState, formData: FormData) => Promise<AuthActionState>;
}) {
  const [state, formAction] = useFormState(action, initialState);
  const isLogin = mode === "login";

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-describedby={state.error ? "form-error" : undefined}
        />
      </div>

      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={isLogin ? "current-password" : "new-password"}
          minLength={isLogin ? undefined : 8}
          required
        />
        {!isLogin && (
          <p className="mt-1.5 text-xs text-ink-faint">Use at least 8 characters.</p>
        )}
      </div>

      {state.error && (
        <div id="form-error">
          <FieldError>{state.error}</FieldError>
        </div>
      )}

      {state.info && (
        <p role="status" className="text-sm text-moss-600">
          {state.info}
        </p>
      )}

      <SubmitButton
        label={isLogin ? "Sign in" : "Create account"}
        pendingLabel={isLogin ? "Signing in…" : "Creating account…"}
      />

      <p className="text-center text-sm text-ink-muted">
        {isLogin ? (
          <>
            New here?{" "}
            <Link href="/signup" className="text-ink underline underline-offset-2">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-ink underline underline-offset-2">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
