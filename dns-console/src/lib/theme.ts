export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'patchvia:theme';

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** What to show: an explicit choice wins, otherwise follow the system. Anything unrecognised means "system". */
export function resolveTheme(
  stored: unknown,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Runs in <head> before the page paints, so the right theme is on <html> from the first frame. It is plain ES5 on purpose
 * and must stay in step with resolveTheme above (a test runs both on the same inputs).
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.setAttribute('data-theme',s==='light'||s==='dark'?s:(d?'dark':'light'))}catch(e){document.documentElement.setAttribute('data-theme','light')}})()`;
