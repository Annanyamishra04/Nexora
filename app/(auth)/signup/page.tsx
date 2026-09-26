import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
import { signup } from "@/app/(auth)/actions";

export const metadata: Metadata = { title: "Create account — Nexora" };

export default function SignupPage() {
  return (
    <div>
      <h1 className="mb-1 text-2xl">Create your account</h1>
      <p className="mb-8 text-sm text-ink-muted">
        Start a workspace for your conversations and documents.
      </p>
      <AuthForm mode="signup" action={signup} />
    </div>
  );
}
