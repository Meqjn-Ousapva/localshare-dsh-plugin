/** Stable, machine-local LocalShare identity. */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'

const ID_PATTERN = /^[A-Za-z0-9._-]{3,80}$/

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidIdentityId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * Resolve the directory holding LocalShare state. Explicit config wins, then
 * the profile's DSH_HOME, then the conventional `~/.dsh`.
 * @param {{ stateDir?: string, profileDir?: string }} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveStateDir(config = {}, env = process.env) {
  if (typeof config.stateDir === 'string' && config.stateDir.trim() !== '') return config.stateDir
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') return env.DSH_HOME
  const home = env.HOME || env.USERPROFILE || '.'
  return path.join(home, '.dsh')
}

/**
 * Load or create the identity file. A read-only filesystem leaves the identity
 * usable for this process and reports a warning instead of failing activation.
 * @param {{ stateDir?: string, identityFile?: string, id?: string, name?: string }} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ identity: { id: string, name: string, hostname: string, createdAt: number }, file: string, warning: string | null }>}
 */
export async function loadIdentity(config = {}, env = process.env) {
  const file = typeof config.identityFile === 'string' && config.identityFile.trim() !== ''
    ? config.identityFile
    : path.join(resolveStateDir(config, env), 'localshare', 'identity.json')
  let stored
  try {
    stored = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    stored = undefined
  }
  const configuredId = isValidIdentityId(config.id) ? config.id : undefined
  const storedId = isValidIdentityId(stored?.id) ? stored.id : undefined
  const id = configuredId ?? storedId ?? `ls-${randomBytes(8).toString('hex')}`
  const configuredName = typeof config.name === 'string' && config.name.trim() !== '' ? config.name.trim() : undefined
  const storedName = typeof stored?.name === 'string' && stored.name.trim() !== '' ? stored.name.trim() : undefined
  const machine = hostname()
  const identity = {
    id,
    name: (configuredName ?? storedName ?? machine).slice(0, 100),
    hostname: machine,
    createdAt: Number.isFinite(stored?.createdAt) ? stored.createdAt : Date.now(),
  }
  let warning = null
  if (stored === undefined || stored.id !== id || stored.name !== identity.name) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, file)
    } catch (error) {
      warning = `无法写入身份文件 ${file}：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { identity, file, warning }
}
