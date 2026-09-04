#!/usr/bin/env node
// OPS-05: refuses to let a deployment start on a development configuration.
// Run it in the release pipeline and as the container's own pre-start step —
// see docs/deploiement.md.
import { checkProductionEnv, formatReport } from "./lib/env-check.mjs";

const report = checkProductionEnv(process.env);
console.log("[check-env] Vérification de la configuration de production :");
console.log(formatReport(report));

if (!report.ok) {
  console.error(
    `\n[check-env] ${report.problems.length} problème(s) bloquant(s). Le déploiement est refusé.`,
  );
  process.exit(1);
}
