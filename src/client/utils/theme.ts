export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'scavenger.theme';
export const THEME_CHANGE_EVENT = 'scavenger:theme-change';

export function readStoredTheme(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : null
): ThemeMode {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY)?.trim().toLowerCase();
    if (raw === 'dark') return 'dark';
    return 'light';
  } catch {
    return 'light';
  }
}

export function writeStoredTheme(
  theme: ThemeMode,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : null
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors in restricted environments
  }
}

export function applyDocumentTheme(
  theme: ThemeMode,
  doc: Document | null | undefined = typeof document !== 'undefined' ? document : null
): void {
  if (!doc?.documentElement) return;
  doc.documentElement.setAttribute('data-theme', theme);
  doc.documentElement.style.colorScheme = theme;
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(new window.CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: theme }));
  }
}

export function getDocumentTheme(
  doc: Document | null | undefined = typeof document !== 'undefined' ? document : null
): ThemeMode {
  const attr = doc?.documentElement?.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

export function toggleThemeMode(current: ThemeMode): ThemeMode {
  return current === 'light' ? 'dark' : 'light';
}
