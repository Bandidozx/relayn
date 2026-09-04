import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import { env } from "@/lib/env";
import "./globals.css";

const DESCRIPTION =
  "Relayn is an OpenAI-compatible AI gateway: one key, many providers, with usage, latency and spend visible per request.";

export const metadata: Metadata = {
  /**
   * The one place the public origin enters the document head. Everything URL-shaped in
   * `metadata` — here and in every route below — resolves against this, so the canonical
   * host is `APP_URL` and never the deployment's own `*.vercel.app` hostname. A deployment
   * reachable on several hostnames still advertises exactly one.
   */
  metadataBase: new URL(env.appUrl),
  title: {
    default: "Relayn — one API key for every model",
    template: "%s · Relayn",
  },
  description: DESCRIPTION,
  applicationName: "Relayn",
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    siteName: "Relayn",
    title: "Relayn — one API key for every model",
    description: DESCRIPTION,
    // Relative, so it is composed with `metadataBase` rather than pinned to a host.
    url: "/",
  },
  twitter: {
    card: "summary",
    title: "Relayn — one API key for every model",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#06080b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
