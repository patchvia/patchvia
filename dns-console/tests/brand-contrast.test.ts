import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The real theme tokens, read from globals.css, so editing a colour there is checked here. */
const css = readFileSync('src/app/globals.css', 'utf8');

function tokens(selector: string): Record<string, [number, number, number]> {
  const block = new RegExp(
    `${selector.replace(/[[\]'.*+?^${}()|\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  if (!block) throw new Error(`no ${selector} block`);
  const out: Record<string, [number, number, number]> = {};
  for (const m of block[1]!.matchAll(
    /--([a-z-]+):\s*(\d+)\s+(\d+)%\s+(\d+)%;/g,
  )) {
    out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

function rgb([h, s, l]: [number, number, number]): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) =>
    L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(c: [number, number, number]) {
  const lin = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground token, background token, minimum ratio]. 4.5 is WCAG AA for text, 3 for UI components and focus rings.
const PAIRS: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['card-foreground', 'card', 4.5],
  ['popover-foreground', 'popover', 4.5],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['secondary-foreground', 'secondary', 4.5],
  ['accent-foreground', 'accent', 4.5],
  ['destructive-foreground', 'destructive', 4.5],
  ['destructive', 'background', 4.5], // error text on the page
  ['destructive', 'card', 4.5], // error text inside cards
  ['primary', 'background', 3],
  ['primary', 'card', 3],
  ['ring', 'background', 3],
];

describe.each([
  ['light', ':root'],
  ['dark', "[data-theme='dark']"],
])('%s theme', (_name, selector) => {
  const t = tokens(selector);
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, min) => {
    expect(t[fg], `missing --${fg}`).toBeDefined();
    expect(t[bg], `missing --${bg}`).toBeDefined();
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(min);
  });
  it('defines every token both themes need', () => {
    const light = Object.keys(tokens(':root')).sort();
    expect(Object.keys(t).sort()).toEqual(light);
  });
});

describe('brand palette', () => {
  it('the light theme uses Mist and Deep Ink, the dark theme a near-black teal page with Deep Ink cards and Jade as primary', () => {
    expect(tokens(':root').primary![0]).toBeCloseTo(175, -1); // teal
    expect(tokens("[data-theme='dark']").primary![0]).toBeCloseTo(158, -1); // jade
    expect(css).toContain('#0b1f24');
    expect(css).toContain('#2ce6a3');
    expect(css).toContain('#b8f56a');
  });
});
