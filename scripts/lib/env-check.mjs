/**
 * OPS-05: the production configuration gate.
 *
 * "Aucune variable de développement" is this ticket's acceptance criterion,
 * and the only way to hold it is to refuse to start rather than to write it
 * in a runbook. Every value this repository ships for local convenience —
 * the compose password, the example metrics token, the raised e2e rate
 * limit — is a value that *works*, which is exactly why it reaches
 * production unnoticed: nothing breaks, the door is simply unlocked.
 *
 * Pure and dependency-free so it can be unit-tested and run before the
 * application opens a single connection.
 */

/** Values that exist in this repository and must never reach production. */
const DEVELOPMENT_VALUES = {
  DATABASE_URL: [
    // docker-compose.yml + .env.example
    "kalloud_dev_password",
  ],
  OPS_METRICS_TOKEN: [".env.example", "dev_metrics_token_change_me", "e2e-ops-token"],
};

/**
 * Deliberately *not* `pg-wait.mjs`'s list, which also treats the hostname
 * `postgres` as local. That list guards destructive scripts, where "a
 * container on this machine" is the thing to be careful about; here the
 * question is different. A compose service reached at `postgres` over a
 * private network is an ordinary production topology
 * (docker-compose.prod.yml), and refusing it would have made this gate
 * reject the very deployment it exists to protect — which is exactly what
 * happened the first time the stack was started.
 *
 * What remains genuinely wrong in production is an application pointed at
 * its own machine's loopback.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Below this, a shared secret is guessable rather than secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Checks `env` as a production configuration.
 *
 * Returns problems rather than throwing on the first one: an operator
 * fixing a deployment wants the whole list, not one item per restart.
 */
export function checkProductionEnv(env) {
  const problems = [];
  const warnings = [];
  const fail = (variable, message) => problems.push({ variable, message });

  if (env.NODE_ENV !== "production") {
    fail("NODE_ENV", `doit valoir "production" (actuel : ${env.NODE_ENV ?? "non défini"}).`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    fail("DATABASE_URL", "est requis.");
  } else {
    let url;
    try {
      url = new URL(databaseUrl);
    } catch {
      fail("DATABASE_URL", "n'est pas une URL valide.");
    }
    if (url) {
      if (LOOPBACK_HOSTS.has(url.hostname)) {
        fail(
          "DATABASE_URL",
          `pointe vers la boucle locale (${url.hostname}) : ce n'est pas une base de production.`,
        );
      }
      if (!url.password) {
        fail("DATABASE_URL", "ne porte aucun mot de passe.");
      }
      for (const value of DEVELOPMENT_VALUES.DATABASE_URL) {
        if (databaseUrl.includes(value)) {
          fail("DATABASE_URL", `contient la valeur de développement « ${value} ».`);
        }
      }
      // sslmode is how a client refuses to fall back to plaintext. DEC-02
      // puts the database behind TLS; without this, a misconfigured server
      // silently downgrades and nothing says so.
      if (!/sslmode=(require|verify-ca|verify-full)/.test(databaseUrl)) {
        warnings.push({
          variable: "DATABASE_URL",
          message:
            "ne force pas TLS (sslmode=require ou plus strict) : à ne laisser ainsi que si le réseau est déjà chiffré de bout en bout.",
        });
      }
    }
  }

  const token = env.OPS_METRICS_TOKEN;
  if (!token) {
    // Not a warning: the endpoint refuses without it, so monitoring would
    // be silently absent — the failure mode OPS-02 exists to remove.
    fail("OPS_METRICS_TOKEN", "est requis, sinon les métriques d'exploitation sont inaccessibles.");
  } else {
    if (DEVELOPMENT_VALUES.OPS_METRICS_TOKEN.some((value) => token.includes(value))) {
      fail(
        "OPS_METRICS_TOKEN",
        "est une valeur d'exemple : générez un secret propre à cet environnement.",
      );
    }
    if (token.length < MIN_SECRET_LENGTH) {
      fail("OPS_METRICS_TOKEN", `fait ${token.length} caractères ; ${MIN_SECRET_LENGTH} minimum.`);
    }
  }

  // Escape hatches that exist for local work. Each one disables a guard
  // this codebase added deliberately, so production is the one place none
  // of them may be set.
  for (const [variable, disables] of [
    ["ALLOW_DEMO_SEED", "l'interdiction de semer des données de démonstration (FND-14)"],
    ["ALLOW_DESTRUCTIVE_DB_RESET", "le refus de détruire un schéma non local"],
    [
      "ALLOW_RESTORE_OVER_APPLICATION_DB",
      "le refus de restaurer par-dessus la base applicative (OPS-03)",
    ],
  ]) {
    if (env[variable] === "true") fail(variable, `est activé et désactive ${disables}.`);
  }

  if (env.AUTH_RATE_LIMIT_MAX !== undefined) {
    const limit = Number(env.AUTH_RATE_LIMIT_MAX);
    if (!Number.isFinite(limit) || limit <= 0) {
      fail("AUTH_RATE_LIMIT_MAX", "doit être un nombre positif.");
    } else if (limit > 100) {
      // playwright.config.ts sets 1000 for the whole e2e suite. In
      // production that is not a rate limit, it is an unlocked door with a
      // sign on it (SEC-07).
      fail(
        "AUTH_RATE_LIMIT_MAX",
        `vaut ${limit} : c'est le plafond de la suite de tests, pas celui d'un client réel (SEC-07 : 30).`,
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

export function formatReport({ ok, problems, warnings }) {
  const lines = [];
  for (const { variable, message } of problems) lines.push(`  ✗ ${variable} ${message}`);
  for (const { variable, message } of warnings) lines.push(`  ! ${variable} ${message}`);
  if (ok && warnings.length === 0) lines.push("  ✓ Configuration de production valide.");
  else if (ok) lines.push("  ✓ Aucun blocage. Avertissements ci-dessus à confirmer.");
  return lines.join("\n");
}
