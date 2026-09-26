import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ProfileForm } from "@/components/settings/profile-form";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { AiPreferencesSection } from "@/components/settings/ai-preferences-section";
import { DataSection } from "@/components/settings/data-section";
import { logout } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Settings — Nexora" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user!.id)
    .single();

  const lastSignInAt = user?.last_sign_in_at
    ? new Date(user.last_sign_in_at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <div>
      <PageHeader title="Settings" description="Manage your account." />

      <div className="max-w-lg space-y-8 p-6 lg:p-10">
        <section className="card-surface p-5">
          <h2 className="mb-1 text-base font-medium text-ink">Profile</h2>
          <p className="mb-4 text-sm text-ink-muted">
            This name is used to greet you in the app.
          </p>
          <ProfileForm initialDisplayName={profile?.display_name ?? null} />
        </section>

        <AppearanceSection />

        <AiPreferencesSection />

        <section className="card-surface p-5">
          <h2 className="mb-1 text-base font-medium text-ink">Account</h2>
          <p className="mb-4 text-sm text-ink-muted">{user?.email}</p>
        </section>

        <DataSection />

        <section className="card-surface p-5">
          <h2 className="mb-1 text-base font-medium text-ink">Security</h2>
          {lastSignInAt && (
            <p className="mb-4 text-sm text-ink-muted">Last signed in {lastSignInAt}.</p>
          )}
          <form action={logout}>
            <Button type="submit" variant="danger" size="sm">
              Sign out
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
