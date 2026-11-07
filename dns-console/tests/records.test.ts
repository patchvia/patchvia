import { describe, expect, it } from 'vitest';
import {
  compareNames,
  composeContent,
  contentError,
  displayName,
  formatTtl,
  isIPv6,
  nameError,
  parseContent,
  summarise,
  toFqdn,
} from '@/lib/records';

describe('names', () => {
  it('expands relative labels to FQDNs', () => {
    expect(toFqdn('www', 'example.com')).toBe('www.example.com');
    expect(toFqdn('@', 'example.com')).toBe('example.com');
    expect(toFqdn('', 'example.com')).toBe('example.com');
    expect(toFqdn('WWW.Example.com.', 'example.com')).toBe('www.example.com');
    expect(toFqdn('a.b', 'example.com')).toBe('a.b.example.com');
    expect(toFqdn('*.apps', 'example.com')).toBe('*.apps.example.com');
  });

  it('does not double-append a name that merely contains the zone text', () => {
    expect(toFqdn('myexample.com', 'example.com')).toBe(
      'myexample.com.example.com',
    );
  });

  it('shows names relative to the zone', () => {
    expect(displayName('example.com', 'example.com')).toBe('@');
    expect(displayName('a.b.example.com', 'example.com')).toBe('a.b');
  });

  it('validates labels', () => {
    expect(nameError('ok-name_1.example.com')).toBeNull();
    expect(nameError('bad name.example.com')).toMatch(/characters/);
    expect(nameError('a..b')).toMatch(/empty/);
    expect(nameError('x'.repeat(64) + '.com')).toMatch(/63/);
    expect(nameError('*.example.com')).toMatch(/wildcard/);
    expect(nameError('*.example.com', { wildcard: true })).toBeNull();
    expect(nameError('a.*.example.com', { wildcard: true })).toMatch(
      /wildcard/,
    );
  });
});

describe('contentError', () => {
  it.each([
    ['A', '192.0.2.10'],
    ['AAAA', '2001:db8::10'],
    ['AAAA', '::1'],
    ['AAAA', '::ffff:1.2.3.4'],
    ['CNAME', 'app.example.com'],
    ['CNAME', 'app.example.com.'],
    ['MX', '10 mail.example.com'],
    ['SRV', '10 5 5060 sip.example.com'],
    ['TXT', '"v=spf1 -all"'],
    ['CAA', '0 issue "letsencrypt.org"'],
    ['NS', 'ns1.example.com'],
  ] as const)('accepts %s %s', (type, content) => {
    expect(contentError(type, content)).toBeNull();
  });

  it.each([
    ['A', '256.1.1.1'],
    ['A', '1.2.3'],
    ['A', 'example.com'],
    ['AAAA', '1.2.3.4'],
    ['AAAA', '2001:db8:::1'],
    ['AAAA', '1:2:3:4:5:6:7:8:9'],
    ['CNAME', 'two words'],
    ['MX', 'mail.example.com'],
    ['MX', 'x mail.example.com'],
    ['MX', '70000 mail.example.com'],
    ['SRV', '1 2 3'],
    ['SRV', '1 2 99999 host.example.com'],
    ['TXT', ''],
    ['CAA', 'issue letsencrypt.org'],
    ['CAA', '300 issue "x"'],
  ] as const)('rejects %s %s', (type, content) => {
    expect(contentError(type, content)).not.toBeNull();
  });

  it('IPv6 edge cases', () => {
    expect(isIPv6('1:2:3:4:5:6:7:8')).toBe(true);
    expect(isIPv6('1::2::3')).toBe(false);
    expect(isIPv6('::')).toBe(true);
    expect(isIPv6('gggg::1')).toBe(false);
  });
});

describe('compose / parse round trip', () => {
  it.each([
    ['A', { ip: '192.0.2.1' }],
    ['MX', { priority: '10', host: 'mail.example.com' }],
    ['SRV', { priority: '1', weight: '2', port: '3', target: 'h.example.com' }],
    ['CAA', { flags: '0', tag: 'issue', value: 'letsencrypt.org' }],
    ['TXT', { text: 'v=spf1 include:a.com ~all' }],
    ['TXT', { text: 'has "quotes" and \\ slash' }],
  ] as const)('%s', (type, fields) => {
    const content = composeContent(type, fields);
    expect(contentError(type, content)).toBeNull();
    expect(parseContent(type, content)).toEqual(fields);
  });

  it('lowercases hostnames and quotes TXT', () => {
    expect(composeContent('CNAME', { target: 'App.Example.COM' })).toBe(
      'app.example.com',
    );
    expect(composeContent('TXT', { text: 'hello world' })).toBe(
      '"hello world"',
    );
  });

  it('parses multi-string TXT into joined text, and summarises for tables', () => {
    expect(parseContent('TXT', '"abc" "def"').text).toBe('abcdef');
    expect(summarise('TXT', '"hello"')).toBe('hello');
    expect(summarise('A', '1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('formatting & ordering', () => {
  it('formats TTLs', () => {
    expect(formatTtl(60)).toBe('1m');
    expect(formatTtl(3600)).toBe('1h');
    expect(formatTtl(86400)).toBe('1d');
    expect(formatTtl(90)).toBe('90s');
    expect(formatTtl(0)).toBe('0s');
  });
  it('puts the apex first', () => {
    expect(
      ['b.z.com', 'z.com', 'a.z.com'].sort((a, b) =>
        compareNames(a, b, 'z.com'),
      ),
    ).toEqual(['z.com', 'a.z.com', 'b.z.com']);
  });
});
