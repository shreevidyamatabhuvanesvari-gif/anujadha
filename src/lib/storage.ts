const STORAGE_KEY = 'shruti-saved-script';

export function readSavedScript(fallback: string): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveScript(script: string): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, script);
    return true;
  } catch {
    return false;
  }
}
