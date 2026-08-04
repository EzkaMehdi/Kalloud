import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Kalloud — Gestion de salle", description: "Caisse, stock et activité" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fr"><body>{children}</body></html>;
}
