/**
 * Auth shell. Signed-in visitors are bounced to the dashboard. The CSRF cookie the
 * login/register forms echo in `x-csrf-token` is issued by `src/proxy.ts` — a layout
 * cannot write cookies in Next.js, so it must not try.
 */
import { redirect } from "next/navigation";
import { Brand } from "@/components/layout/brand";
import { getSession } from "@/lib/auth/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Brand href="/" />
        <a href="/#api" className="text-xs text-ink-muted transition-colors hover:text-ink">
          See the API →
        </a>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-6 sm:px-6">
        <div className="w-full max-w-100">{children}</div>
      </main>

      <footer className="px-5 py-6 text-center text-[11px] text-ink-faint sm:px-8">
        Relayn is a self-hosted AI gateway. Your API keys never leave your deployment.
      </footer>
    </div>
  );
}
