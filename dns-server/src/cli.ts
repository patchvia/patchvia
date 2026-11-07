import { randomBytes } from 'node:crypto'
import { loadConfig } from './config/config.js'
import { openDatabase } from './db/database.js'
import { ResetError, resetPassword } from './cli/reset-password.js'
import { readSecret } from './cli/prompt.js'

const HELP = `Patchvia DNS server commands. Run them where the database is, for example:
  docker exec -it <container> node dist/cli.js <command>

Commands:
  reset-password <username> [--generate | --password-stdin]
      Sets a new password for an existing user and signs that user out everywhere. With no option it asks for the
      password twice, hidden. --generate makes a random one and prints it once. --password-stdin reads it from a pipe,
      so it never appears in shell history or the process list.
      In a cluster, run it on any one node: the others pick the change up on their next sync.

The database is the one the server uses (DB_PATH, default ./data/dns.db). The server can keep running.`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return command ? 0 : 2
  }
  if (command !== 'reset-password') {
    console.error(`unknown command "${command}"\n\n${HELP}`)
    return 2
  }
  const flags = rest.filter((a) => a.startsWith('--'))
  const names = rest.filter((a) => !a.startsWith('--'))
  const unknown = flags.filter((f) => f !== '--generate' && f !== '--password-stdin')
  if (unknown.length || names.length !== 1 || (flags.includes('--generate') && flags.includes('--password-stdin'))) {
    console.error(`usage: reset-password <username> [--generate | --password-stdin]`)
    return 2
  }

  const generate = flags.includes('--generate')
  let password: string
  if (generate) {
    password = randomBytes(15).toString('base64url')
  } else if (flags.includes('--password-stdin')) {
    password = await readSecret('')
  } else {
    password = await readSecret('New password: ')
    if (password !== (await readSecret('Repeat it:   '))) {
      console.error('The two passwords differ. Nothing was changed.')
      return 1
    }
  }

  const db = openDatabase(loadConfig().dbPath)
  try {
    const user = await resetPassword(db, names[0]!, password)
    console.log(`Password changed for ${user.username} (${user.role}). Their sessions have ended.`)
    if (generate) console.log(`New password (shown once): ${password}`)
    return 0
  } catch (e) {
    if (e instanceof ResetError) {
      console.error(e.message)
      return 1
    }
    throw e
  } finally {
    db.close()
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
