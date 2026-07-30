import "./globals.css";
import Providers from "./providers";
import Nav from "@/components/Nav";

export const metadata = {
  title: "Folio — Every token, told as a story",
  description: "A testnet token launchpad where every token is an article.",
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
