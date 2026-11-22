/** Durable provenance for conversations imported through LocalShare. */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Retain only the most recent import records. */
export const MAX_IMPORT_RECORDS = 200

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isImportRecord(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.localSessionId === 'string'
    && typeof value.sourcePeerId === 'string'
    && typeof value.sourceSessionId === 'string'
    && typeof value.targetDir === 'string'
}

/**
 * @param {string} file
 * @returns {Promise<any[]>}
 */
export async function loadImports(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('imports file must contain a JSON array')
  return parsed.filter(isImportRecord).slice(0, MAX_IMPORT_RECORDS)
}

/**
 * @param {string} file
 * @param {readonly any[]} records
 * @returns {Promise<void>}
 */
export async function saveImports(file, records) {
  const list = records.filter(isImportRecord).slice(0, MAX_IMPORT_RECORDS)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
}
