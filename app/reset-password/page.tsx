"use client";

import { CheckCircle2, Coffee, KeyRound } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!token) {
      setError("Lien de réinitialisation invalide.");
      return;
    }
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    if (password !== confirmation) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Une erreur est survenue.");
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
          Kalloud
        </div>
        <h1 className="auth-title">Nouveau mot de passe</h1>
        <p className="auth-subtitle">Choisissez un nouveau mot de passe</p>

        {done ? (
          <div>
            <p className="modal-help" role="status">
              <CheckCircle2 size={16} style={{ verticalAlign: "middle", marginRight: 6 }} />
              Mot de passe mis à jour. Vos autres sessions ont été déconnectées.
            </p>
            <Link
              className="primary-button"
              href="/login"
              style={{ width: "100%", justifyContent: "center" }}
            >
              Se connecter
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <TextField
              label="Nouveau mot de passe"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint="Au moins 8 caractères."
              required
            />
            <TextField
              label="Confirmer le mot de passe"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              style={{ width: "100%", marginTop: 20 }}
              disabled={submitting}
            >
              <KeyRound size={18} />
              {submitting ? "Mise à jour…" : "Réinitialiser le mot de passe"}
            </button>
          </form>
        )}

        <p className="auth-links">
          <Link href="/login">Retour à la connexion</Link>
        </p>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
