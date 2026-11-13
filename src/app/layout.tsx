import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Foreman — The General Contractor Agent for the NEAR Agent Economy",
  description:
    "Give Foreman a task and a budget. It breaks the work into parts, hires specialist agents, negotiates quotes, checks the work, and pays out — everything inside your budget, settled on NEAR.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
