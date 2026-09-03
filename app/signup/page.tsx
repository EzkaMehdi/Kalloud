"use client";

import { Coffee, Store } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

/**
 * SAAS-01: the first of DEC-01's mandatory journeys. Before this page, a new
 * customer existed only if someone ran SQL for them.
 *
 * Four fields, and no more. Timezone, currency, tax rate and the cash
 * threshold all have defaults (migrations/0002) that CFG-01 lets the owner
 * change once they are inside; asking for them here would put a settings
 * form between someone and a product they have not seen yet. The
 * establishment's name doubles as the organization's, which is DEC-01's "un
 * établissement par organisation" and not a shortcut.
 */
export default function Signup() {
  const router = useRouter();
  const [establishmentName, setEstablishmentName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!establishmentName.trim() || !ownerName.trim() || !email.trim() || !password) {
      setError("Renseignez tous les champs pour créer votre établissement.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          establishmentName: establishmentName.trim(),
          ownerName: ownerName.trim(),
          email,
          password,
        }),
        suppressAuthRedirect: true,
      });
      // The response already carries the session cookie, so the next screen
      // is the configuration one — the establishment exists but has no
      // tables and no catalogue yet, and that is what to do next.
      router.push("/configuration");
      router.refresh();
    } catch (caught) {
      // UX-05: the typed values stay. A refused signup is usually a taken
      // e-mail or a weak password — one field to change, not a form to
      // fill again.
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Création impossible pour le moment. Réessayez.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand" aria-hidden="true">
          <span className="brand-mark">
            <Coffee size={18} />
          </span>
          Samppli
        </div>
        <h1 className="auth-title">Créer mon établissement</h1>
        <p className="auth-subtitle">
          Quelques secondes suffisent : vous configurerez vos tables et votre carte juste après.
        </p>
        <form onSubmit={handleSubmit} noValidate>
          <TextField
            label="Nom de l'établissement"
            autoComplete="organization"
            value={establishmentName}
            onChange={(event) => setEstablishmentName(event.target.value)}
            placeholder="Ex. Le Comptoir du Marché"
            required
          />
          <TextField
            label="Votre nom"
            autoComplete="name"
            value={ownerName}
            onChange={(event) => setOwnerName(event.target.value)}
            placeholder="Ex. Amine Bernard"
            required
          />
          <TextField
            label="Adresse e-mail"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <TextField
            label="Mot de passe"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            // The hint states what `assertPasswordStrength` actually
            // enforces (8 characters, no complexity rule) rather than a
            // stricter-sounding policy the server would not apply — a form
            // that asks for more than it checks teaches users to distrust it.
            hint="Au moins 8 caractères."
            required
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={submitting} style={{ width: "100%" }}>
            <Store size={18} aria-hidden="true" />
            {submitting ? "Création…" : "Créer mon établissement"}
          </button>
        </form>
        <p className="auth-subtitle" style={{ marginTop: 18 }}>
          Vous avez déjà un compte ? <Link href="/login">Se connecter</Link>
        </p>
      </div>
    </div>
  );
}
