/**
 * Thin access layer over the WebExtension APIs.
 *
 * Firefox exposes the promise-based `browser` namespace; the fallbacks keep
 * these modules importable from unit tests, where no extension runtime exists.
 */

interface MinimalRuntime {
  sendMessage: (message: unknown) => Promise<unknown>;
  getManifest: () => { version: string };
  getURL: (path: string) => string;
}

declare const chrome: typeof browser | undefined;

function globalBrowser(): typeof browser | undefined {
  if (typeof browser !== 'undefined') return browser;
  if (typeof chrome !== 'undefined') return chrome;
  return undefined;
}

/** True when running inside an extension context. */
export function hasRuntime(): boolean {
  return globalBrowser()?.runtime !== undefined;
}

export function runtime(): MinimalRuntime {
  const api = globalBrowser();
  if (!api?.runtime) throw new Error('WebExtension runtime unavailable');
  return api.runtime as unknown as MinimalRuntime;
}

export function storage(): browser.storage.StorageArea {
  const api = globalBrowser();
  if (!api?.storage) throw new Error('WebExtension storage unavailable');
  return api.storage.local;
}

export function extensionVersion(): string {
  try {
    return runtime().getManifest().version;
  } catch {
    return '0.0.0';
  }
}

/** Reads one key, returning `fallback` when absent or unreadable. */
export async function readKey<T>(key: string, fallback: T): Promise<T> {
  try {
    const result = await storage().get(key);
    const value = (result as Record<string, unknown>)[key];
    return value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

export async function writeKey(key: string, value: unknown): Promise<void> {
  await storage().set({ [key]: value });
}

export type StorageChanges = Record<string, browser.storage.StorageChange>;

/**
 * Subscribes to `storage.local` changes.
 *
 * This is how settings reach content scripts and open dashboards: the
 * background page is the only writer, and everyone else reacts. Doing it
 * through storage rather than `tabs.sendMessage` keeps the manifest down to a
 * single `storage` permission.
 */
export function onStorageChanged(listener: (changes: StorageChanges) => void): void {
  const api = globalBrowser();
  api?.storage?.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') listener(changes as StorageChanges);
  });
}
