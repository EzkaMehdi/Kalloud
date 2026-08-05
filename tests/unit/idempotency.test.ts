import { describe, expect, it } from "vitest";
import { ValidationError } from "../../lib/errors";
import { canonicalJson, hashPayload, requireIdempotencyKey } from "../../lib/idempotency";

describe("API-02: the request hash is stable across key order", () => {
  it("hashes objects that differ only in key order identically", () => {
    // A retry is the *same* request re-sent. If JSON.stringify happened to
    // emit fields in another order, hashing the raw text would reject the
    // retry as "same key, different payload" — and DEC-08 requires exactly
    // that retry to succeed.
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload({ outer: { x: 1, y: 2 }, z: 3 })).toBe(
      hashPayload({ z: 3, outer: { y: 2, x: 1 } }),
    );
  });

  it("keeps array order significant", () => {
    // Two lines of product 1 then 2 is not the same ticket as 2 then 1 for
    // hashing purposes, and pretending otherwise would let a genuinely
    // different request replay a stored result.
    expect(hashPayload([1, 2])).not.toBe(hashPayload([2, 1]));
  });

  it("treats a changed value as a different request", () => {
    expect(hashPayload({ amount: 20 })).not.toBe(hashPayload({ amount: 21 }));
    expect(hashPayload({ amount: 20 })).not.toBe(hashPayload({ amount: "20" }));
  });

  it("ignores undefined properties, which JSON never transmits anyway", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("serialises deterministically for nested structures", () => {
    expect(canonicalJson({ b: [3, { d: 4, c: 5 }], a: null })).toBe(
      '{"a":null,"b":[3,{"c":5,"d":4}]}',
    );
  });
});

describe("API-02: the Idempotency-Key header is required and bounded", () => {
  function requestWith(headers: Record<string, string>) {
    return new Request("https://example.test/api/checkout", { method: "POST", headers });
  }

  it("accepts a UUID, the form the client generates", () => {
    const key = "6f5a1f0e-1b2c-4d3e-8f90-1a2b3c4d5e6f";
    expect(requireIdempotencyKey(requestWith({ "Idempotency-Key": key }))).toBe(key);
  });

  it("is case-insensitive about the header name, as HTTP requires", () => {
    const key = "0123456789abcdef0123";
    expect(requireIdempotencyKey(requestWith({ "idempotency-key": key }))).toBe(key);
  });

  it("refuses a missing key rather than silently processing without protection", () => {
    expect(() => requireIdempotencyKey(requestWith({}))).toThrow(ValidationError);
  });

  it("refuses keys that are too short, too long, or carry unexpected characters", () => {
    for (const key of ["short", "a".repeat(201), "has spaces here!!", "clé/avec/slash?!"]) {
      expect(
        () => requireIdempotencyKey(requestWith({ "Idempotency-Key": key })),
        `expected "${key.slice(0, 20)}" to be rejected`,
      ).toThrow(ValidationError);
    }
  });
});
