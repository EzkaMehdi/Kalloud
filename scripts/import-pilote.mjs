#!/usr/bin/env node
// OPS-09: brings a real customer's catalogue and floor plan in from a
// spreadsheet, so a pilot does not start by typing eighty products one at a
// time. See docs/pilote.md.
//
//   IMPORT_PASSWORD=… node scripts/import-pilote.mjs \
//     --url http://localhost:3000 --email proprietaire@exemple.fr \
//     --produits catalogue.csv --tables salle.csv --simulation
import { readFile } from "node:fs/promises";
import { readCsvRecords } from "./lib/csv-read.mjs";

const options = parseArgs(process.argv.slice(2));

if (!options.email || (!options.produits && !options.tables)) {
  console.log(
    [
      "Import pilote (OPS-09)",
      "",
      "  --url <base>          Adresse de l'application (défaut http://localhost:3000)",
      "  --email <adresse>     Compte propriétaire de l'établissement",
      "  --produits <f.csv>    Catalogue : colonnes nom, prix, [categorie, unite, stock, seuil]",
      "  --tables <f.csv>      Plan de salle : colonne nom",
      "  --simulation          Valide et affiche ce qui serait créé, sans rien écrire",
      "",
      "Le mot de passe se lit dans la variable d'environnement IMPORT_PASSWORD,",
      "jamais sur la ligne de commande : les arguments sont visibles de tout",
      "processus de la machine.",
    ].join("\n"),
  );
  process.exit(options.email ? 1 : 0);
}

const password = process.env.IMPORT_PASSWORD;
if (!password) {
  console.error("[import] IMPORT_PASSWORD n'est pas définie.");
  process.exit(1);
}

const base = (options.url ?? "http://localhost:3000").replace(/\/$/, "");

/**
 * Everything goes through the HTTP API as the establishment's own owner,
 * never through SQL.
 *
 * That is not a stylistic choice. The rules that make a catalogue correct —
 * the tax fallback chain (DEC-05), the opening-balance movement that keeps
 * `products.stock_quantity` equal to the sum of its movements (DEC-06), the
 * audit trail (SEC-09), the permission checks — all live in the services
 * behind these endpoints. An importer that wrote rows directly would have to
 * reimplement them, and would drift from them on the first change. This one
 * does exactly what a person doing it by hand would do, eighty times.
 */
let cookie = "";

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const login = await call("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: options.email, password }),
});
if (login.status !== 200) {
  console.error(`[import] Connexion refusée (${login.status}) : ${describe(login.body)}`);
  process.exit(1);
}
console.log(`[import] Connecté en tant que ${options.email} sur ${base}`);

const existingProducts = (await call("/api/products")).body ?? [];
const existingTables = (await call("/api/tables?all=true")).body ?? [];
const categories = (await call("/api/categories")).body ?? [];
const categoryByName = new Map(
  (Array.isArray(categories) ? categories : []).map((category) => [
    category.name.trim().toLowerCase(),
    category.id,
  ]),
);

let created = 0;
let skipped = 0;
let failed = 0;

if (options.tables) {
  const { records } = readCsvRecords(await readFile(options.tables, "utf8"));
  const taken = new Set(
    (Array.isArray(existingTables) ? existingTables : []).map((table) =>
      table.name.trim().toLowerCase(),
    ),
  );
  console.log(`\n[import] Plan de salle : ${records.length} ligne(s)`);
  for (const record of records) {
    const name = record.nom ?? record.table ?? "";
    if (!name) {
      report("✗", record.__line, "nom manquant");
      failed += 1;
      continue;
    }
    // Idempotent by name: re-running an import after fixing three rows must
    // not produce a second "Terrasse 1".
    if (taken.has(name.toLowerCase())) {
      report("=", record.__line, `${name} — existe déjà`);
      skipped += 1;
      continue;
    }
    if (options.simulation) {
      report("+", record.__line, `${name} (simulation)`);
      created += 1;
      continue;
    }
    const response = await call("/api/tables", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (response.status === 201 || response.status === 200) {
      taken.add(name.toLowerCase());
      report("+", record.__line, name);
      created += 1;
    } else {
      report("✗", record.__line, `${name} — ${describe(response.body)}`);
      failed += 1;
    }
  }
}

if (options.produits) {
  const { records } = readCsvRecords(await readFile(options.produits, "utf8"));
  const taken = new Set(
    (Array.isArray(existingProducts) ? existingProducts : []).map((product) =>
      product.name.trim().toLowerCase(),
    ),
  );
  console.log(`\n[import] Catalogue : ${records.length} ligne(s)`);
  for (const record of records) {
    const name = record.nom ?? record.produit ?? "";
    const price = toAmount(record.prix ?? record.price ?? "");
    if (!name) {
      report("✗", record.__line, "nom manquant");
      failed += 1;
      continue;
    }
    if (price === null) {
      report("✗", record.__line, `${name} — prix illisible « ${record.prix ?? ""} »`);
      failed += 1;
      continue;
    }
    if (taken.has(name.toLowerCase())) {
      report("=", record.__line, `${name} — existe déjà`);
      skipped += 1;
      continue;
    }

    const categoryName = (record.categorie ?? "").trim().toLowerCase();
    if (categoryName && !categoryByName.has(categoryName)) {
      if (options.simulation) {
        report("+", record.__line, `catégorie « ${record.categorie} » (simulation)`);
      } else {
        const response = await call("/api/categories", {
          method: "POST",
          body: JSON.stringify({ name: record.categorie.trim() }),
        });
        if (response.status === 201 || response.status === 200) {
          categoryByName.set(categoryName, response.body.id);
        } else {
          report(
            "✗",
            record.__line,
            `catégorie « ${record.categorie} » — ${describe(response.body)}`,
          );
        }
      }
    }

    const payload = {
      categoryId: categoryByName.get(categoryName) ?? null,
      name,
      price,
      ...(record.unite ? { unit: record.unite } : {}),
      ...(toInteger(record.stock) !== null ? { stockQuantity: toInteger(record.stock) } : {}),
      ...(toInteger(record.seuil) !== null ? { alertThreshold: toInteger(record.seuil) } : {}),
    };

    if (options.simulation) {
      report(
        "+",
        record.__line,
        `${name} — ${price} €${payload.stockQuantity != null ? `, ${payload.stockQuantity} en stock` : ""} (simulation)`,
      );
      created += 1;
      continue;
    }
    const response = await call("/api/products", { method: "POST", body: JSON.stringify(payload) });
    if (response.status === 201 || response.status === 200) {
      taken.add(name.toLowerCase());
      report("+", record.__line, `${name} — ${price} €`);
      created += 1;
    } else {
      report("✗", record.__line, `${name} — ${describe(response.body)}`);
      failed += 1;
    }
  }
}

console.log(
  `\n[import] ${options.simulation ? "Simulation : " : ""}${created} créé(s), ${skipped} déjà présent(s), ${failed} en échec.`,
);
if (options.simulation) {
  console.log("[import] Rien n'a été écrit. Relancez sans --simulation pour appliquer.");
}
process.exitCode = failed > 0 ? 1 : 0;

function report(symbol, line, message) {
  console.log(`  ${symbol} L${String(line).padStart(3)}  ${message}`);
}

/** "2,50" and "2.50" both mean the same thing to a person; the API takes two decimals. */
function toAmount(raw) {
  const cleaned = raw.replace(/\s|€/g, "").replace(",", ".");
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned).toFixed(2);
}

function toInteger(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/\s/g, "");
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
}

function describe(body) {
  if (!body) return "réponse vide";
  if (typeof body === "string") return body.slice(0, 120);
  return body.error?.message ?? JSON.stringify(body).slice(0, 120);
}

function parseArgs(argv) {
  const parsed = { url: null, email: null, produits: null, tables: null, simulation: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--url") parsed.url = argv[++index];
    else if (argv[index] === "--email") parsed.email = argv[++index];
    else if (argv[index] === "--produits") parsed.produits = argv[++index];
    else if (argv[index] === "--tables") parsed.tables = argv[++index];
    else if (argv[index] === "--simulation") parsed.simulation = true;
  }
  return parsed;
}
