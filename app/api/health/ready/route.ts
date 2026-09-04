import { pingDatabase } from "@/lib/db";
import { ServiceUnavailableError } from "@/lib/errors";
import { apiRoute, jsonOk } from "@/lib/http";
import { getSchemaVersionStatus } from "@/lib/schema-version";

/**
 * FND-09: readiness checks the one dependency that matters (Postgres).
 * If pingDatabase() throws a connectivity error, apiRoute's shared error
 * mapping turns it into a 503 without ever crashing the process (P0-09).
 *
 * OPS-05 added the second question: does this image's schema match the
 * database it just connected to? Reachability alone is the right check on a
 * first deploy and the wrong one on a rollback — migrations here are
 * forward-only, so an older image comes up against a newer schema and
 * appears to work until the query that hits a renamed column, mid-service.
 * An orchestrator that only ever asked "can you connect" would route
 * customers straight to it.
 */
export const GET = apiRoute(async () => {
  await pingDatabase();

  const schema = await getSchemaVersionStatus();
  if (!schema.matches) {
    throw new ServiceUnavailableError(
      schema.missing.length > 0
        ? `Migrations non appliquées (${schema.missing.length}) : le déploiement n'est pas terminé.`
        : `La base est en avance sur cette version de l'application (${schema.unknown.length} migration(s) inconnue(s)).`,
    );
  }

  return jsonOk({
    status: "ready",
    schema: { applied: schema.applied, expected: schema.expected },
  });
});
