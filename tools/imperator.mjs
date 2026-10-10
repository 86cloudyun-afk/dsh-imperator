#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor, backup, preflight, restore, operationErrorCode } from '../lib/operations/index.js'

const HELP = 'Imperator local operators\n'
  + 'imperator doctor --root /absolute/taskforce [--json]\n'
  + 'imperator backup --root /absolute/taskforce --out /absolute/new-backup [--json]\n'
  + 'imperator preflight --root /absolute/taskforce [--json]\n'
  + 'imperator restore --backup /absolute/backup --out /absolute/new-staging-root [--json]\n'
  + 'Explicit paths only. Doctor is read-only. Restore never replaces production or restarts services.\n'
const commands = { doctor, backup, preflight, restore }
const fields = { doctor: ['root'], backup: ['root', 'out'], preflight: ['root'], restore: ['backup', 'out'] }
const inputError = () => { throw Object.assign(new Error('E_OPERATIONS_INPUT'), { code: 'E_OPERATIONS_INPUT' }) }

export async function main(argv = process.argv.slice(2)) {
  let command = 'usage'
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      process.stdout.write(HELP)
      return 0
    }
    if (!Object.hasOwn(commands, argv[0])) inputError()
    command = argv[0]
    const options = {}, seen = new Set()
    for (let index = 1; index < argv.length; index++) {
      const flag = argv[index]
      if (seen.has(flag)) inputError()
      seen.add(flag)
      if (flag === '--json') continue
      if (!fields[command].some(field => flag === '--' + field)) inputError()
      const value = argv[++index]
      if (typeof value !== 'string' || value.startsWith('--')) inputError()
      options[flag.slice(2)] = value
    }
    if (!fields[command].every(field => typeof options[field] === 'string')) inputError()
    const result = await commands[command](options)
    process.stdout.write(JSON.stringify(result) + '\n')
    return result.ok ? 0 : 1
  } catch (error) {
    process.stdout.write(JSON.stringify({ command, ok: false, code: operationErrorCode(error) }) + '\n')
    return 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
