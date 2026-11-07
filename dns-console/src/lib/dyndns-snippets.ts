export interface DynSnippets {
  /** Host (and port when not standard) for clients that take server and path separately */
  server: string;
  https: boolean;
  routerPath: string;
  curl: string;
  ddclient: string;
}

/** Ready-to-paste configuration for a dynamic DNS token. `apiUrl` is where the DNS API is reachable from the device. */
export function dynSnippets(
  apiUrl: string,
  fqdn: string,
  token: string,
): DynSnippets {
  const u = new URL(apiUrl);
  const https = u.protocol === 'https:';
  const base = `${u.protocol}//${u.host}`;
  return {
    server: u.host,
    https,
    routerPath: `/nic/update?hostname=${fqdn}&myip=<ipaddr>`,
    // With no address given the update uses the one the request comes from, which is what a home router wants
    curl: `curl -fsS "${base}/dyn/update?token=${token}"`,
    ddclient: [
      'protocol=dyndns2',
      `server=${u.host}`,
      ...(https ? ['ssl=yes'] : []),
      'login=ddns',
      `password='${token}'`,
      fqdn,
    ].join('\n'),
  };
}
