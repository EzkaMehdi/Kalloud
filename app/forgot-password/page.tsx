"use client";

import { Coffee, Send } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

interface RequestResetResponse {
  message: string;
  devToken?: string;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RequestResetResponse | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!email.trim()) {
      setError("Indiquez votre adresse e-mail.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await apiFetch<RequestResetResponse>("/api/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setResult(response);
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
        <h1 className="auth-title">Mot de passe oublié</h1>
        <p className="auth-subtitle">Recevez un lien pour réinitialiser votre mot de passe</p>

        {result ? (
          <div>
            <p className="modal-help" role="status">
              {result.message}
            </p>
            {result.devToken && (
              <div className="auth-devbox">
                Environnement de développement : aucun e-mail n&apos;est envoyé pour le moment.{" "}
                <Link href={`/reset-password?token=${encodeURIComponent(result.devToken)}`}>
                  Continuer la réinitialisation
                </Link>
                .
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <TextField
              label="Adresse e-mail"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
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
              <Send size={18} />
              {submitting ? "Envoi…" : "Envoyer le lien"}
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
