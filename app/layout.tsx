import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Skylark BI Agent",
  description: "Founder-level BI agent over monday.com Work Orders & Deals",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
