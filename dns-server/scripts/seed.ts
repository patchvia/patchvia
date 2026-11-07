import { loadConfig } from '../src/config/config.js'
import { openDatabase } from '../src/db/database.js'
import { ZoneIndex } from '../src/zones/zone-index.js'
import { ZoneRepository } from '../src/zones/zone-repository.js'
import { ZoneService } from '../src/zones/zone-service.js'

const db = openDatabase(loadConfig().dbPath)
const svc = new ZoneService(new ZoneRepository(db), new ZoneIndex())
if (svc.listZones().some((z) => z.name === 'example.test')) {
  console.log('example.test already exists')
  process.exit(0)
}
const rec = (content: string) => [{ content, disabled: false }]
svc.createZone({ name: 'example.test', nameservers: ['ns1.example.test', 'ns2.example.test'] })
svc.setRRset('example.test', 'ns1.example.test', 'A', 3600, rec('192.0.2.53'))
svc.setRRset('example.test', 'ns2.example.test', 'A', 3600, rec('192.0.2.54'))
svc.setRRset('example.test', 'example.test', 'A', 300, rec('192.0.2.10'))
svc.setRRset('example.test', 'example.test', 'AAAA', 300, rec('2001:db8::10'))
svc.setRRset('example.test', 'example.test', 'MX', 3600, [...rec('10 mail.example.test'), ...rec('20 mail2.example.test')])
svc.setRRset('example.test', 'mail.example.test', 'A', 3600, rec('192.0.2.25'))
svc.setRRset('example.test', 'example.test', 'TXT', 300, rec('"v=spf1 mx -all"'))
svc.setRRset('example.test', 'www.example.test', 'CNAME', 300, rec('example.test'))
svc.setRRset('example.test', '*.dev.example.test', 'A', 60, rec('192.0.2.99'))
svc.setRRset('example.test', 'example.test', 'CAA', 3600, rec('0 issue "letsencrypt.org"'))
svc.setRRset('example.test', '_sip._tcp.example.test', 'SRV', 3600, rec('10 5 5060 sip.example.test'))
svc.setRRset('example.test', 'sub.example.test', 'NS', 3600, rec('ns.other.test'))
console.log('seeded example.test')
