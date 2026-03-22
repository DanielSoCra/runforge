import '@testing-library/jest-dom';

// Node 22+ ships a built-in localStorage that lacks .clear() and conflicts
// with jsdom's implementation. Provide a spec-compliant in-memory fallback
// so tests that use localStorage.clear/getItem/setItem work reliably.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.clear !== 'function') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  } as Storage;
}
