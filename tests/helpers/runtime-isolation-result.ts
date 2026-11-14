const prefix = 'SUPPORT_RUNTIME_RESULT '
const maxResultLength = 16_384

export function writeRuntimeResult(value: unknown) {
  console.info(`${prefix}${JSON.stringify(value)}`)
}

export function readRuntimeResult(stdout: string) {
  // Native dependencies may log before or after the fixture's own result.
  // Accept exactly one bounded result line, never an arbitrary JSON-looking log.
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix))
  if (lines.length !== 1) throw new Error(`Expected exactly one runtime result, received ${lines.length}`)
  const line = lines[0]!
  if (line.length > maxResultLength) throw new Error('Runtime result exceeds the fixture size limit')
  return JSON.parse(line.slice(prefix.length))
}
