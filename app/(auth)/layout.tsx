export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1fr_minmax(0,440px)]">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-moss-700 p-12 text-on-accent lg:flex">
        {/* Subtle dot-grid motif — restrained, no gradients or glow. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        />
        <span className="relative flex items-center gap-2.5">
          <span
            className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
            style={{ background: "rgb(var(--color-moss-300))" }}
          >
            <span className="h-2 w-2 rounded-[2px] bg-moss-700" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-serif text-xl tracking-tight">Nexora</span>
            <span className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-on-accent/70">
              AI Knowledge Workspace
            </span>
          </span>
        </span>
        <blockquote className="relative max-w-sm font-serif text-2xl leading-snug">
          Read, ask, and keep what matters — with the sources to back it up.
        </blockquote>
        <p className="relative text-sm text-on-accent/75">
          A workspace for conversations grounded in your own documents.
        </p>
      </div>

      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <span className="mb-10 flex items-center gap-2 lg:hidden">
            <span className="brand-mark" aria-hidden="true" />
            <span className="font-serif text-xl tracking-tight text-ink">Nexora</span>
          </span>
          {children}
        </div>
      </div>
    </div>
  );
}
