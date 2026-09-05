import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import { env } from "@/lib/env";
import "./globals.css";

/**
 * Both faces are downloaded at build time and served from this origin — `next/font` rewrites the
 * `@font-face` rules to `/_next/static/media/…`, so a visitor's browser never contacts Google and
 * the CSP in `next.config.ts` needs no `font-src` allowance beyond `'self'`.
 *
 * Variable fonts, so one file covers 100–900 and no weight list is needed. `variable` exposes each
 * as a CSS custom property that `--font-sans` / `--font-mono` in `globals.css` point at; the class
 * names go on `<html>` so the properties are defined on the same element the tokens resolve on.
 *
 * `display: "swap"` plus the size-adjusted fallback `next/font` generates from the real font
 * metrics means text is readable immediately and does not reflow when the face arrives.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

/**
 * Resolves the palette before the first paint.
 *
 * This runs as a synchronous inline script rather than in a `useEffect` because the alternative is a
 * visible flash: the server cannot know a visitor's theme, so any React-driven answer arrives one
 * paint too late and a light-mode visitor watches the page start black. Reading `localStorage`
 * synchronously, as the first thing inside `<body>`, means the correct palette is in place before
 * any content after it is parsed — so before anything is drawn — at the cost of one attribute React
 * must be told not to diff (`suppressHydrationWarning` on `<html>`).
 *
 * Raw markup, deliberately **not** `next/script` with `strategy="beforeInteractive"`. That strategy
 * neither hoists an inline script into `<head>` nor executes it during parsing: Next emits it as a
 * `(self.__next_s=self.__next_s||[]).push(…)` registration at the top of `<body>`, and the code only
 * runs once Next's own runtime chunks drain that queue — chunks loaded with `async`, so none of them
 * block the parser. That makes flash-freedom a race against the network rather than a guarantee, and
 * the first deploy of this file lost it: the served HTML contained no synchronous theme code at all,
 * only the queued string. Markup in the document stream has no such dependency.
 *
 * It is injected through `dangerouslySetInnerHTML` on a wrapper rather than written as a `<script>`
 * element, because React does not hydrate script elements: rendering one from a component makes the
 * client take its create path, which appends a second, permanently inert copy next to the one the
 * parser already ran (two `<script>` nodes in `<body>`, measured) and logs
 * `Encountered a script tag while rendering React component` — dev-only, but the duplicate is not.
 * Inside `dangerouslySetInnerHTML` the tag is opaque to React, so nothing is diffed or re-created,
 * while the server still streams a real `<script>` that the HTML parser executes where it sits.
 *
 * It does not re-run on a client navigation, which is correct — `data-theme` survives a soft
 * navigation and the toggle owns every change after boot.
 *
 * No stored choice falls through to the OS preference, so the default is the visitor's, not ours.
 * Wrapped in try/catch because `localStorage` throws outright in a partitioned or cookie-blocked
 * context, and a theme is never worth a blank page.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("relayn-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}`;

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
  /**
   * One colour per scheme, so the browser chrome on mobile matches the palette the theme script
   * picks. These track `prefers-color-scheme` rather than `data-theme`: a `<meta>` tag cannot
   * follow an attribute, and the OS preference is the right answer for the common case.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eff3f8" },
    { media: "(prefers-color-scheme: dark)", color: "#06080b" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      // `data-theme` is written by THEME_SCRIPT, before React sees the document.
      suppressHydrationWarning
    >
      <body className="min-h-dvh antialiased">
        {/*
          First child of `<body>`: the parser reaches and runs this before any painted markup.
          `hidden` because the wrapper exists only to carry the tag — it must never be a layout box.
        */}
        <div hidden dangerouslySetInnerHTML={{ __html: `<script>${THEME_SCRIPT}</script>` }} />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
