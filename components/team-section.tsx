"use client";

import { UserPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { TextField } from "@/components/ui/text-field";
import { apiFetch } from "@/lib/client/api";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/authz";
import type { AsyncState } from "@/lib/client/use-async-data";

export interface TeamMember {
  user_id: number;
  name: string;
  email: string;
  role: Role;
  status: "ACTIVE" | "DISABLED";
}

/**
 * SAAS-02: the owner's team screen — add a member, change a role, suspend
 * and restore.
 *
 * Owner-only, mirroring `users:manage` (DEC-07). The server is what refuses
 * a manager or a cashier; hiding the section is only so the interface does
 * not offer a button that would 403 (DEC-07: "l'interface masque également
 * les actions non permises […] mais ce n'est qu'un confort").
 *
 * Roles are rendered through `ROLE_LABELS`, the single place role names are
 * translated (UX-06), rather than a second vocabulary invented here.
 */
export function TeamSection({
  state,
  currentUserId,
  onChanged,
  onRetry,
  onError,
  onNotice,
}: {
  state: AsyncState<TeamMember[]>;
  currentUserId: number | null;
  onChanged: () => void;
  onRetry: () => void;
  onError: (caught: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("CASHIER");
  const [saving, setSaving] = useState(false);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/api/team", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, role }),
      });
      setName("");
      setEmail("");
      setPassword("");
      onChanged();
      onNotice("Membre ajouté");
    } catch (caught) {
      onError(caught, "Impossible d'ajouter ce membre.");
    } finally {
      setSaving(false);
    }
  }

  async function patch(member: TeamMember, body: object, notice: string, fallback: string) {
    try {
      await apiFetch(`/api/team/${member.user_id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onChanged();
      onNotice(notice);
    } catch (caught) {
      onError(caught, fallback);
    }
  }

  return (
    <>
      <div className="section-title">
        <div>
          <h2>Équipe</h2>
          <p className="eyebrow">
            Un membre désactivé perd l’accès immédiatement, sans disparaître de l’historique
          </p>
        </div>
      </div>
      <AsyncSection state={state} onRetry={onRetry}>
        {(members) => (
          <div className="history-card">
            {members.map((member) => (
              <div className="order-row" key={member.user_id}>
                <div>
                  <b>{member.name}</b>
                  <small>
                    {member.email} · {ROLE_LABELS[member.role]}
                    {member.status === "ACTIVE" ? "" : " · désactivé"}
                    {member.user_id === currentUserId ? " · vous" : ""}
                  </small>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <label className="visually-hidden" htmlFor={`role-${member.user_id}`}>
                    Rôle de {member.name}
                  </label>
                  <select
                    id={`role-${member.user_id}`}
                    className="input"
                    style={{ width: "auto" }}
                    value={member.role}
                    onChange={(event) =>
                      patch(
                        member,
                        { role: event.target.value },
                        `${member.name} est maintenant ${ROLE_LABELS[event.target.value as Role]}`,
                        "Impossible de changer ce rôle.",
                      )
                    }
                  >
                    {ROLES.map((value) => (
                      <option key={value} value={value}>
                        {ROLE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="soft-button"
                    onClick={() =>
                      patch(
                        member,
                        { isActive: member.status !== "ACTIVE" },
                        member.status === "ACTIVE"
                          ? `${member.name} désactivé`
                          : `${member.name} réactivé`,
                        "Impossible de modifier ce membre.",
                      )
                    }
                  >
                    {member.status === "ACTIVE" ? "Désactiver" : "Réactiver"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>

      <form onSubmit={invite} className="history-card" style={{ padding: 16, marginTop: 12 }}>
        <TextField
          label="Nouveau membre"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ex. Sarah Bernard"
          required
        />
        <TextField
          label="Adresse e-mail"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <TextField
          label="Mot de passe initial"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          // Said plainly rather than implied: there is no invitation e-mail
          // to send (see lib/services/team.ts), so the owner hands this over
          // and the employee changes it from "mot de passe oublié".
          hint="Au moins 8 caractères. À communiquer à la personne, qui pourra le changer."
          required
        />
        <label className="field-label">
          Rôle
          <select
            className="input"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" disabled={saving} style={{ width: "100%" }}>
          <UserPlus size={18} aria-hidden="true" />
          {saving ? "Ajout…" : "Ajouter au personnel"}
        </button>
      </form>
    </>
  );
}
