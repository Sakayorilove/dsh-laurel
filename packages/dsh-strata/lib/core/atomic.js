import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// The destination is never truncated. Unique temp files also avoid writer collisions.
export function atomicWrite(path, payload) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, payload, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
  }
}
