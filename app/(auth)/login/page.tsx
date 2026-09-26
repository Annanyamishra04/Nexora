import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
import { login } from "@/app/(auth)/actions";

export const metadata: Metadata = { title: "Sign in — Nexora" };

export default function LoginPage() {
  return (
    <div>
      <h1 className="mb-1 text-2xl">Sign in</h1>
      <p className="mb-8 text-sm text-ink-muted">Welcome back. Enter your details to continue.</p>
      <AuthForm mode="login" action={login} />
    </div>
  );
}
