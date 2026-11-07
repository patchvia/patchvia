import { describe, expect, it } from 'vitest';
import { dynSnippets } from '@/lib/dyndns-snippets';

describe('dynSnippets', () => {
  it('builds https snippets with ssl=yes and no explicit port', () => {
    const s = dynSnippets(
      'https://dns.example.com',
      'home.example.com',
      'ddns_abc',
    );
    expect(s.server).toBe('dns.example.com');
    expect(s.https).toBe(true);
    expect(s.curl).toBe(
      'curl -fsS "https://dns.example.com/dyn/update?token=ddns_abc"',
    );
    expect(s.routerPath).toBe(
      '/nic/update?hostname=home.example.com&myip=<ipaddr>',
    );
    expect(s.ddclient).toBe(
      [
        'protocol=dyndns2',
        'server=dns.example.com',
        'ssl=yes',
        'login=ddns',
        "password='ddns_abc'",
        'home.example.com',
      ].join('\n'),
    );
  });
  it('keeps a non-standard port and omits ssl for http', () => {
    const s = dynSnippets('http://192.0.2.5:8081/', 'h.example.com', 'ddns_x');
    expect(s.server).toBe('192.0.2.5:8081');
    expect(s.https).toBe(false);
    expect(s.curl).toBe(
      'curl -fsS "http://192.0.2.5:8081/dyn/update?token=ddns_x"',
    );
    expect(s.ddclient).not.toContain('ssl=yes');
  });
  it('ignores any path on the API URL, since the endpoints are at the root', () => {
    expect(dynSnippets('https://x.test/api/', 'a.x.test', 't').curl).toBe(
      'curl -fsS "https://x.test/dyn/update?token=t"',
    );
  });
});
