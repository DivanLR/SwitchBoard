// The database MCP scan writes its schema map to `.switchboard/db-schema.md`
// inside a project's folder. Shared here so both the renderer-facing
// `mcp.readSchema` IPC and session startup (which injects the doc as system
// context) read the same path without duplicating the convention.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function schemaDocPath(projectPath: string): string {
  return join(projectPath, '.switchboard', 'db-schema.md')
}

export function readSchemaDoc(projectPath: string): string | null {
  const path = schemaDocPath(projectPath)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
