import { ForbiddenError } from "./errors";

/** The three MVP roles (DEC-07). Exactly one per user per organization (memberships.role). */
export type Role = "OWNER" | "MANAGER" | "CASHIER";

export const ROLES: readonly Role[] = ["OWNER", "MANAGER", "CASHIER"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** UX-06: the one place role names are translated for display, so the UI never invents a second vocabulary. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
  OWNER: "Propriétaire",
  MANAGER: "Responsable",
  CASHIER: "Caissier",
});

/**
 * Every sensitive action in the product, named independently of any single
 * endpoint so a route can require exactly the permission it needs. This is
 * the literal, testable encoding of the matrix in
 * docs/decisions/DEC-07-roles-permissions.md — keep both in sync.
 */
export type Permission =
  | "settings:manage"
  | "users:manage"
  | "catalog:manage"
  | "tables:manage"
  | "business_day:open"
  | "business_day:close"
  | "orders:create"
  | "orders:cancel_open"
  | "orders:discount"
  | "orders:refund"
  | "cash_movement:create"
  | "stock:adjust"
  | "dashboard:view"
  | "export:create"
  | "audit:view";

export const PERMISSIONS: Readonly<Record<Permission, readonly Role[]>> = Object.freeze({
  "settings:manage": ["OWNER"],
  "users:manage": ["OWNER"],
  "catalog:manage": ["OWNER", "MANAGER"],
  "tables:manage": ["OWNER", "MANAGER"],
  "business_day:open": ["OWNER", "MANAGER", "CASHIER"],
  "business_day:close": ["OWNER", "MANAGER", "CASHIER"],
  "orders:create": ["OWNER", "MANAGER", "CASHIER"],
  "orders:cancel_open": ["OWNER", "MANAGER", "CASHIER"],
  "orders:discount": ["OWNER", "MANAGER"],
  "orders:refund": ["OWNER", "MANAGER"],
  "cash_movement:create": ["OWNER", "MANAGER", "CASHIER"],
  "stock:adjust": ["OWNER", "MANAGER"],
  "dashboard:view": ["OWNER", "MANAGER"],
  "export:create": ["OWNER", "MANAGER"],
  "audit:view": ["OWNER", "MANAGER"],
});

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission].includes(role);
}

/** Throws a 403 ForbiddenError (never a silently-ignored client-side check) when the role lacks the permission. */
export function requirePermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ForbiddenError(`Le rôle ${role} ne peut pas effectuer l'action "${permission}".`);
  }
}
