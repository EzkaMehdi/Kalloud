"use client";

import { useState } from "react";
import { AsyncSection } from "@/components/ui/async-section";
import { Shell } from "@/components/shell";
import { TextField } from "@/components/ui/text-field";
import { ApiError, apiFetch } from "@/lib/client/api";
import { useAsyncData } from "@/lib/client/use-async-data";
import { useCurrentUser } from "@/lib/client/use-current-user";

/**
 * Phase 4B: the screen that makes GATE-4B's "le propriétaire configure son
 * établissement sans SQL" true.
 *
 * Three sections, matching the three tasks: the establishment's own settings
 * (CFG-01, OWNER only), the catalogue's categories (CFG-02) and the floor
 * plan (CFG-03). Products keep their existing screen — this one adds what
 * had no home at all.
 */

interface Settings {
  timezone: string;
  currency: string;
  defaultTaxRate: number;
  cashDiscrepancyThreshold: number;
}

interface TaxClass {
  id: number;
  name: string;
  rate: number;
  isDefault: boolean;
}

interface Configuration {
  name: string;
  settings: Settings;
  taxClasses: TaxClass[];
}

interface Category {
  id: number;
  name: string;
  tax_class_id: number | null;
}

interface TableRow {
  id: number;
  name: string;
  is_active: boolean;
  display_order: number;
  is_occupied: boolean;
}

export default function Configuration() {
  const user = useCurrentUser();
  // DEC-07: `settings:manage` is the OWNER's alone — a manager runs the
  // establishment, the owner defines it. The catalogue and floor plan are
  // `catalog:manage`/`tables:manage`, which a manager does hold.
  const isOwner = user?.role === "OWNER";
  const canManage = isOwner || user?.role === "MANAGER";

  const configQuery = useAsyncData(() => apiFetch<Configuration>("/api/settings"), []);
  const categoriesQuery = useAsyncData(() => apiFetch<Category[]>("/api/categories"), []);
  const tablesQuery = useAsyncData(() => apiFetch<TableRow[]>("/api/tables?all=true"), []);

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function report(message: string) {
    setNotice(message);
    setError("");
    setTimeout(() => setNotice(""), 3500);
  }

  function fail(caught: unknown, fallback: string) {
    setError(caught instanceof ApiError ? caught.message : fallback);
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Configuration</h1>
        </div>
      </div>

      {notice && (
        <div className="status" style={{ marginBottom: 12 }} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {notice}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="section-title">
        <div>
          <h2>Établissement</h2>
          <p className="eyebrow">Nom, fuseau, devise et règles fiscales</p>
        </div>
      </div>
      <AsyncSection state={configQuery.state} onRetry={configQuery.refetch}>
        {(configuration) => (
          <SettingsForm
            configuration={configuration}
            readOnly={!isOwner}
            onSaved={() => {
              configQuery.refetch();
              report("Réglages enregistrés");
            }}
            onError={(caught) => fail(caught, "Impossible d'enregistrer les réglages.")}
          />
        )}
      </AsyncSection>

      <div className="section-title">
        <div>
          <h2>Catégories</h2>
          <p className="eyebrow">La classe fiscale d’une catégorie s’applique à ses produits</p>
        </div>
      </div>
      <AsyncSection
        state={categoriesQuery.state}
        onRetry={categoriesQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucune catégorie. Créez-en une ci-dessous."
      >
        {(categories) => (
          <div className="history-card">
            {categories.map((category) => (
              <div className="order-row" key={category.id}>
                <div>
                  <b>{category.name}</b>
                </div>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>
      {canManage && (
        <NameForm
          label="Nouvelle catégorie"
          placeholder="Ex. Desserts"
          onSubmit={async (name) => {
            await apiFetch("/api/categories", { method: "POST", body: JSON.stringify({ name }) });
            categoriesQuery.refetch();
            report("Catégorie créée");
          }}
          onError={(caught) => fail(caught, "Impossible de créer la catégorie.")}
        />
      )}

      <div className="section-title">
        <div>
          <h2>Plan de salle</h2>
          <p className="eyebrow">Une table occupée ne peut pas être désactivée</p>
        </div>
      </div>
      <AsyncSection
        state={tablesQuery.state}
        onRetry={tablesQuery.refetch}
        isEmpty={(data) => data.length === 0}
        emptyMessage="Aucune table. Créez-en une ci-dessous."
      >
        {(tables) => (
          <div className="history-card">
            {tables.map((table) => (
              <div className="order-row" key={table.id}>
                <div>
                  <b>{table.name}</b>
                  <small>
                    {table.is_active ? "Active" : "Désactivée"}
                    {table.is_occupied && " · ticket en cours"}
                  </small>
                </div>
                {canManage && (
                  <button
                    className="link-button"
                    onClick={async () => {
                      try {
                        await apiFetch(`/api/tables/${table.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ isActive: !table.is_active }),
                        });
                        tablesQuery.refetch();
                        report(table.is_active ? "Table désactivée" : "Table réactivée");
                      } catch (caught) {
                        fail(caught, "Impossible de modifier la table.");
                      }
                    }}
                  >
                    {table.is_active ? "Désactiver" : "Réactiver"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </AsyncSection>
      {canManage && (
        <NameForm
          label="Nouvelle table"
          placeholder="Ex. Terrasse 3"
          onSubmit={async (name) => {
            await apiFetch("/api/tables", { method: "POST", body: JSON.stringify({ name }) });
            tablesQuery.refetch();
            report("Table créée");
          }}
          onError={(caught) => fail(caught, "Impossible de créer la table.")}
        />
      )}
    </Shell>
  );
}

function SettingsForm({
  configuration,
  readOnly,
  onSaved,
  onError,
}: {
  configuration: Configuration;
  readOnly: boolean;
  onSaved: () => void;
  onError: (caught: unknown) => void;
}) {
  const [name, setName] = useState(configuration.name);
  const [timezone, setTimezone] = useState(configuration.settings.timezone);
  const [currency, setCurrency] = useState(configuration.settings.currency);
  const [taxRate, setTaxRate] = useState(configuration.settings.defaultTaxRate.toFixed(2));
  const [threshold, setThreshold] = useState(
    configuration.settings.cashDiscrepancyThreshold.toFixed(2),
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          name,
          timezone,
          currency,
          defaultTaxRate: Number(taxRate).toFixed(2),
          cashDiscrepancyThreshold: Number(threshold).toFixed(2),
        }),
      });
      onSaved();
    } catch (caught) {
      onError(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="history-card">
      <TextField
        label="Nom de l’établissement"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={readOnly}
      />
      <TextField
        label="Fuseau horaire (IANA, ex. Europe/Paris)"
        value={timezone}
        onChange={(event) => setTimezone(event.target.value)}
        disabled={readOnly}
      />
      <TextField
        label="Devise (code ISO, ex. EUR)"
        value={currency}
        onChange={(event) => setCurrency(event.target.value)}
        disabled={readOnly}
      />
      <TextField
        label="Taux de TVA par défaut (%)"
        type="number"
        step="0.01"
        min="0"
        max="100"
        value={taxRate}
        onChange={(event) => setTaxRate(event.target.value)}
        disabled={readOnly}
      />
      <TextField
        label="Seuil d’écart de caisse toléré"
        type="number"
        step="0.01"
        min="0"
        value={threshold}
        onChange={(event) => setThreshold(event.target.value)}
        disabled={readOnly}
      />
      {readOnly ? (
        // UX-01: say why the form is inert rather than leaving a manager to
        // wonder whether it is broken.
        <p className="stock-meta">
          Ces réglages définissent l’établissement : seul le propriétaire peut les modifier.
        </p>
      ) : (
        <button
          className="primary-button"
          style={{ width: "100%" }}
          disabled={saving}
          onClick={save}
        >
          {saving ? "Enregistrement…" : "Enregistrer les réglages"}
        </button>
      )}
    </div>
  );
}

function NameForm({
  label,
  placeholder,
  onSubmit,
  onError,
}: {
  label: string;
  placeholder: string;
  onSubmit: (name: string) => Promise<void>;
  onError: (caught: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <div className="history-card">
      <TextField
        label={label}
        value={name}
        placeholder={placeholder}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        className="primary-button"
        style={{ width: "100%" }}
        disabled={saving || !name.trim()}
        onClick={async () => {
          setSaving(true);
          try {
            await onSubmit(name.trim());
            setName("");
          } catch (caught) {
            onError(caught);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Enregistrement…" : "Créer"}
      </button>
    </div>
  );
}
