import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, requirePermission, type Permission, type Role } from "../../lib/authz";
import { ForbiddenError } from "../../lib/errors";

/**
 * Encodes the exact matrix from docs/decisions/DEC-07-roles-permissions.md
 * as data so a change to either the code or the decision doc that breaks
 * the other fails loudly here instead of silently drifting.
 */
const EXPECTED_MATRIX: Record<Permission, readonly Role[]> = {
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
};

const ALL_ROLES: readonly Role[] = ["OWNER", "MANAGER", "CASHIER"];

describe("authz permission matrix (DEC-07)", () => {
  it("matches the documented matrix exactly, permission by permission and role by role", () => {
    for (const [permission, allowedRoles] of Object.entries(EXPECTED_MATRIX) as [
      Permission,
      readonly Role[],
    ][]) {
      for (const role of ALL_ROLES) {
        expect(
          can(role, permission),
          `expected can(${role}, "${permission}") to be ${allowedRoles.includes(role)}`,
        ).toBe(allowedRoles.includes(role));
      }
    }
  });

  it("does not define any permission outside the documented set", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED_MATRIX).sort());
  });

  it("OWNER can do everything a MANAGER can (matrix is a strict superset)", () => {
    for (const allowedRoles of Object.values(PERMISSIONS)) {
      if (allowedRoles.includes("MANAGER")) {
        expect(allowedRoles).toContain("OWNER");
      }
    }
  });

  it("requirePermission throws a 403 ForbiddenError for a disallowed role", () => {
    expect(() => requirePermission("CASHIER", "stock:adjust")).toThrow(ForbiddenError);
    try {
      requirePermission("CASHIER", "stock:adjust");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).statusCode).toBe(403);
    }
  });

  it("requirePermission does not throw for an allowed role", () => {
    expect(() => requirePermission("CASHIER", "orders:create")).not.toThrow();
    expect(() => requirePermission("OWNER", "settings:manage")).not.toThrow();
  });
});
