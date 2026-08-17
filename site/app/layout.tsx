import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "../components/brand-mark";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://shelly.sh"),
  title: {
    default: "Shelly",
    template: "%s · Shelly",
  },
  description:
    "Open-source terminal handoff for any CLI: keep one PTY session alive on your computer and continue it from Android.",
  openGraph: {
    siteName: "Shelly",
    type: "website",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#10130f",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/" aria-label="Shelly home">
            <BrandMark className="brand-mark" />
            <span>Shelly</span>
          </Link>
          <nav aria-label="Primary navigation">
            <Link href="/install/">Install</Link>
            <Link href="/architecture/">Architecture</Link>
            <Link href="/protocol/">Protocol</Link>
            <Link href="/privacy/">Privacy</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <span>Your terminal sessions, from anywhere.</span>
          <span>
            <a href="https://github.com/iamjr15/shelly">GitHub</a>
            <Link href="/privacy/">Privacy</Link>
          </span>
        </footer>
      </body>
    </html>
  );
}
