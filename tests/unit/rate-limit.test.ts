import { describe, expect, it, vi } from "vitest";
import { isRateLimited } from "../../lib/security/rate-limit";

/**
 * SEC-07's coarse per-key limiter (proxy.ts's own request-shape checks,
 * ahead of any route handler) had no test at all before this — this
 * exercises the primitive proxy.ts's AUTH_RATE_LIMIT_MAX now parameterizes
 * (SALE-06's e2e suite outgrew the fixed default; see proxy.ts's own doc
 * comment on AUTH_RATE_LIMIT_MAX), so the mechanism it configures is at
 * least proven correct on its own.
 */
describe("SEC-07: isRateLimited", () => {
  it("allows requests up to and including the max within the window", () => {
    const key = `test-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(key, { windowMs: 60_000, max: 5 })).toBe(false);
    }
  });

  it("blocks the request that exceeds the max within the window", () => {
    const key = `test-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      isRateLimited(key, { windowMs: 60_000, max: 5 });
    }
    expect(isRateLimited(key, { windowMs: 60_000, max: 5 })).toBe(true);
  });

  it("resets once the window has elapsed", () => {
    vi.useFakeTimers();
    try {
      const key = `test-${crypto.randomUUID()}`;
      for (let i = 0; i < 5; i++) {
        isRateLimited(key, { windowMs: 60_000, max: 5 });
      }
      expect(isRateLimited(key, { windowMs: 60_000, max: 5 })).toBe(true);

      vi.advanceTimersByTime(60_001);

      expect(isRateLimited(key, { windowMs: 60_000, max: 5 })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks distinct keys independently", () => {
    const keyA = `test-${crypto.randomUUID()}`;
    const keyB = `test-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      isRateLimited(keyA, { windowMs: 60_000, max: 5 });
    }
    // keyA is now over budget; keyB, untouched, must not be affected by it.
    expect(isRateLimited(keyB, { windowMs: 60_000, max: 5 })).toBe(false);
  });
});
