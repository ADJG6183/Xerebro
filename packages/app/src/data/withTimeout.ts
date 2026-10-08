/**
 * Race `promise` against a `ms` timeout. The loser is abandoned, not
 * cancelled (plain promises can't be) — a late result from the losing side
 * simply has no further effect here; callers must not act on it again once
 * this has already resolved. Used anywhere a network call must not be
 * allowed to hang the caller indefinitely (performanceBudget.md: never
 * block on network).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
