"use client";

import { Coffee, LogIn } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/caisse";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Indiquez votre e-mail et votre mot de passe.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        suppressAuthRedirect: true,
      });
      router.push(next);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Connexion impossible. Réessayez.");
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
        <h1 className="auth-title">Connexion</h1>
        <p className="auth-subtitle">Connectez-vous pour accéder à votre établissement</p>
        <form onSubmit={handleSubmit} noValidate>
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
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
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
            <LogIn size={18} />
            {submitting ? "Connexion…" : "Se connecter"}
          </button>
        </form>
        <p className="auth-links">
          <Link href="/forgot-password">Mot de passe oublié ?</Link>
        </p>
        <div className="auth-devbox">
          Comptes de démonstration (mot de passe : <strong>Kalloud123!</strong>) :
          owner@kalloud.test · manager@kalloud.test · cashier@kalloud.test
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
