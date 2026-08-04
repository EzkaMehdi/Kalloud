import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kalloud — Gestion de salle",
  description: "Caisse, stock et activité",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>
        {/* UX-03: lets keyboard users bypass the repeated nav on every page. */}
        <a href="#main-content" className="skip-link">
          Aller au contenu principal
        </a>
        {children}
      </body>
    </html>
  );
}
