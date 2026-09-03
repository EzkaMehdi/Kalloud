"use client";

import Link from "next/link";
import { Check } from "lucide-react";

/**
 * SAAS-01: the remaining steps of DEC-01's first journey, for an
 * establishment that has just been created.
 *
 * Signup produces a real but empty establishment: no tables, no catalogue,
 * no open service. Each of those has had its own screen for several phases
 * (CFG-03, CFG-02 plus this ticket's catalogue section, CASH-02), and none
 * of them announced itself — a new owner landed on a configuration page and
 * had to infer both the order and the destination.
 *
 * It disappears on its own once the three steps are done, rather than
 * becoming permanent furniture for an establishment that has been running
 * for months.
 */
export function OnboardingChecklist({
  tableCount,
  productCount,
  serviceOpen,
}: {
  tableCount: number;
  productCount: number;
  serviceOpen: boolean;
}) {
  const steps = [
    {
      done: tableCount > 0,
      label: "Créer vos tables",
      hint: "Le plan de salle, plus bas sur cette page.",
      href: null,
    },
    {
      done: productCount > 0,
      label: "Ajouter vos produits",
      hint: "Le catalogue, plus bas sur cette page.",
      href: null,
    },
    {
      done: serviceOpen,
      label: "Ouvrir votre premier service",
      hint: "Depuis la caisse, en indiquant votre fond de caisse.",
      href: "/caisse",
    },
  ];

  if (steps.every((step) => step.done)) return null;

  return (
    <div className="history-card" style={{ padding: 16, marginBottom: 16 }}>
      <b>Pour commencer</b>
      <p className="stock-meta" style={{ marginTop: 4 }}>
        {steps.filter((step) => step.done).length} étape(s) sur {steps.length} — votre établissement
        est créé, il reste à le préparer.
      </p>
      <div style={{ marginTop: 12 }}>
        {steps.map((step) => (
          <div className="order-row" key={step.label}>
            <div>
              <b style={{ opacity: step.done ? 0.55 : 1 }}>
                {step.done ? "✓ " : ""}
                {step.label}
              </b>
              <small>{step.done ? "Fait" : step.hint}</small>
            </div>
            {!step.done && step.href && (
              <Link className="soft-button" href={step.href}>
                Y aller
              </Link>
            )}
            {step.done && <Check size={16} aria-hidden="true" />}
          </div>
        ))}
      </div>
    </div>
  );
}
