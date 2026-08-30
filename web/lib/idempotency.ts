export function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

const sessionPrefix = "stripe-entitlements:idempotency:";
const memoryKeys = new Map<string, string>();

function sessionKey(intent: string): string {
  return `${sessionPrefix}${encodeURIComponent(intent)}`;
}

function readSessionKey(intent: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(sessionKey(intent));
  } catch {
    return null;
  }
}

function writeSessionKey(intent: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(sessionKey(intent), value);
  } catch {
    // In-memory retry protection remains available when storage is blocked.
  }
}

export function idempotencyKeyForIntent(intent: string): string {
  const existing = readSessionKey(intent) ?? memoryKeys.get(intent);
  if (existing) return existing;
  const value = createIdempotencyKey();
  memoryKeys.set(intent, value);
  writeSessionKey(intent, value);
  return value;
}

export function completeIdempotentIntent(intent: string): void {
  memoryKeys.delete(intent);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(sessionKey(intent));
  } catch {
    // The in-memory value was still cleared.
  }
}

/** Clear browser retry identities before an authenticated host changes subject. */
export function clearAllIdempotentIntents(): void {
  memoryKeys.clear();
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(sessionPrefix)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // In-memory identities were still cleared. The host should replace the tab when
    // browser storage is unavailable during an authenticated subject change.
  }
}
