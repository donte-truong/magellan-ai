import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import "./experience.css";
import "./research.css";
import "./agent.css";

export const metadata: Metadata = {
  title: "Magellan — A world within",
  description:
    "Discover what a product is made of and explore the evidence behind its supply network.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
