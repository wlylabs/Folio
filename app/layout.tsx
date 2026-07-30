import "./globals.css";
import Providers from "./providers";
import Nav from "@/components/Nav";

import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Folio — Every token, told as a story",
  description: "A testnet token launchpad where every token is an article.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
