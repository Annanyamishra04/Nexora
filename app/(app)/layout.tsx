import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defense in depth: middleware already redirects unauthenticated
  // requests away from this route group, but a Server Component should
  // never assume a request reached it legitimately.
  if (!user) {
    redirect("/login");
  }

  const { data: recentConversations } = await supabase
    .from("conversations")
    .select("id, title")
    .order("updated_at", { ascending: false })
    .limit(6);

  return (
    <AppShell email={user.email ?? "Account"} recentConversations={recentConversations ?? []}>
      {children}
    </AppShell>
  );
}
