import { loadConfig } from './config/config.js'
import { createApp } from './bootstrap.js'
import { listenTcp, listenUdp } from './dns/listeners.js'
import { compileAcl } from './common/cidr.js'
import { ResponseRateLimiter } from './dns/rrl.js'
import { Stats } from './dns/stats.js'
import { SecondaryManager } from './replication/secondary.js'
import { transferPolicy } from './dns/transfer.js'
import { ZoneIndex } from './zones/zone-index.js'

async function main() {
  const cfg = loadConfig()
  const app = await createApp(cfg)
  await app.init() // opens the database and loads zones before any traffic is accepted

  const index = app.get(ZoneIndex)
  const secondary = app.get(SecondaryManager)
  const ctx = {
    stats: app.get(Stats),
    limiter: new ResponseRateLimiter({
      responsesPerSecond: cfg.rrlResponsesPerSecond,
      slip: cfg.rrlSlip,
      exempt: compileAcl(cfg.rrlExempt),
    }),
    maxTcpPerIp: cfg.tcpMaxPerIp,
    transfers: transferPolicy(index, compileAcl(cfg.allowAxfrFrom)),
    notify: (zone: string, remote: string | undefined) => secondary.handleNotify(zone, remote),
  }
  if (cfg.allowAxfrFrom.length === 0) console.log('zone transfers (AXFR/IXFR) are disabled: set ALLOW_AXFR_FROM to enable them')
  const udp = await listenUdp(app.get(ZoneIndex), cfg.dnsHost, cfg.dnsPort, ctx)
  const tcp = await listenTcp(app.get(ZoneIndex), cfg.dnsHost, cfg.dnsPort, ctx)
  await app.listen(cfg.apiPort, cfg.apiHost)
  console.log(`dns on [${cfg.dnsHost}]:${udp.port} (udp+tcp), api on ${cfg.apiHost}:${cfg.apiPort}`)

  const shutdown = async () => {
    await Promise.all([udp.close(), tcp.close()])
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
