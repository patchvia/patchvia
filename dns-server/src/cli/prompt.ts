import { stdin, stdout } from 'node:process'

/** Reads one line without echoing it. On a pipe (no terminal) it reads the first line of input instead. */
export function readSecret(label: string): Promise<string> {
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (c) => (data += c))
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''))
      stdin.on('error', reject)
    })
  }
  return new Promise((resolve) => {
    stdout.write(label)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          stdout.write('\n')
          return resolve(value)
        }
        if (ch === '\u0003') {
          stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.on('data', onData)
  })
}
