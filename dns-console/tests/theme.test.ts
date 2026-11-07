import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  isThemeChoice,
  resolveTheme,
} from '@/lib/theme';

/** Runs the head script in a fake browser and returns the data-theme it sets. */
function boot(opts: {
  stored?: string | null;
  systemDark: boolean;
  storageThrows?: boolean;
}): string | null {
  let attr: string | null = null;
  const window = { matchMedia: () => ({ matches: opts.systemDark }) };
  const localStorage = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new Error('blocked');
      return k === THEME_STORAGE_KEY ? (opts.stored ?? null) : null;
    },
  };
  const document = {
    documentElement: { setAttribute: (_: string, v: string) => (attr = v) },
  };
  vm.runInNewContext(THEME_BOOT_SCRIPT, { window, localStorage, document });
  return attr;
}

describe('resolveTheme', () => {
  it('an explicit choice wins over the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('system, nothing and junk all follow the system', () => {
    for (const v of ['system', null, undefined, '', 'purple', 3]) {
      expect(resolveTheme(v, true)).toBe('dark');
      expect(resolveTheme(v, false)).toBe('light');
    }
  });
  it('recognises the three choices only', () => {
    expect(['light', 'dark', 'system'].every(isThemeChoice)).toBe(true);
    expect([null, 'auto', 'Dark', 1].some(isThemeChoice)).toBe(false);
  });
});

describe('the pre-paint boot script', () => {
  const cases: [string | null, boolean][] = [
    ['light', true],
    ['light', false],
    ['dark', true],
    ['dark', false],
    ['system', true],
    ['system', false],
    [null, true],
    [null, false],
    ['garbage', true],
  ];
  it.each(cases)(
    'agrees with resolveTheme for stored=%s, system dark=%s',
    (stored, systemDark) => {
      expect(boot({ stored, systemDark })).toBe(
        resolveTheme(stored, systemDark),
      );
    },
  );
  it('falls back to light when storage is blocked (private windows, strict settings)', () => {
    expect(boot({ systemDark: true, storageThrows: true })).toBe('light');
  });
  it('is small enough to inline in every page', () => {
    expect(THEME_BOOT_SCRIPT.length).toBeLessThan(500);
  });
});
