/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    dirs: ["app", "components", "lib"],
  },
  // Next.js 14.2 still requires this flag for instrumentation.ts's
  // register() hook (used for env validation on boot — see
  // instrumentation.ts); it becomes the default in Next.js 15.
  experimental: {
    instrumentationHook: true,
  },
  // Security headers (Phase 6). Deliberately no Content-Security-Policy:
  // this app streams from Supabase (websockets/https), calls Gemini
  // server-side only (never from the browser), and the existing UI was
  // not audited against a CSP — adding one blind risks silently breaking
  // auth or streaming (see phase brief, "do not introduce a complicated
  // CSP that breaks the existing application"). The headers below are
  // safe, low-risk, and don't depend on knowing every script/style source.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Prevents browsers from MIME-sniffing a response away from
          // its declared Content-Type (e.g. treating an uploaded
          // document as executable script).
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Send no referrer cross-origin, and only the origin
          // same-origin -> cross-origin; never leaks full URLs
          // (which can contain conversation/document ids) to third
          // parties.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // This app is never meant to be framed by another site —
          // blocks clickjacking.
          { key: "X-Frame-Options", value: "DENY" },
          // Disable powerful browser features this app never uses.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
