import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/supabase/types";

/**
 * Supabase client for use in Server Components, Route Handlers, and
 * Server Actions. Uses the request's cookie jar so the authenticated
 * user's session is available on the server — never the service role key.
 *
 * NOTE: Server Components can read cookies but not write them. Calling
 * `.set` / `.remove` from a Server Component is a no-op guarded by the
 * try/catch below; session refresh actually happens in `middleware.ts`,
 * which can write cookies on every request.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options as CookieOptions);
            });
          } catch {
            // Called from a Server Component — safe to ignore because
            // middleware refreshes the session on the surrounding request.
          }
        },
      },
    }
  );
}
