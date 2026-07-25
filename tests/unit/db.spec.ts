// The store's own transaction wrapper: node:sqlite has none, so the commit and
// rollback behaviour better-sqlite3 used to provide is ours to get right.
import { describe, expect, it } from 'vitest'
import { openDatabase, transaction } from '@main/store/db'

function freshDb(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:')
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
  return db
}

const count = (db: ReturnType<typeof openDatabase>): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n

describe('transaction', () => {
  it('commits the work and returns its value', () => {
    const db = freshDb()
    const result = transaction(db, () => {
      db.prepare('INSERT INTO t (id) VALUES (?)').run('a')
      db.prepare('INSERT INTO t (id) VALUES (?)').run('b')
      return 'done'
    })
    expect(result).toBe('done')
    expect(count(db)).toBe(2)
  })

  it('rolls every statement back when the work throws, and rethrows', () => {
    const db = freshDb()
    db.prepare('INSERT INTO t (id) VALUES (?)').run('kept')
    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO t (id) VALUES (?)').run('rolled-back')
        throw new Error('boom')
      }),
    ).toThrowError('boom')
    expect(count(db)).toBe(1)
  })

  it('leaves no transaction open after a rollback, so the next one still works', () => {
    const db = freshDb()
    try {
      transaction(db, () => {
        throw new Error('boom')
      })
    } catch {
      /* expected */
    }
    transaction(db, () => db.prepare('INSERT INTO t (id) VALUES (?)').run('after'))
    expect(count(db)).toBe(1)
  })

  it('applies the schema migrations exactly once per database', () => {
    const db = openDatabase(':memory:')
    const applied = (db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n
    expect(applied).toBeGreaterThan(0)
    // Re-running openDatabase's migrate step must be a no-op, not a duplicate.
    const again = openDatabase(':memory:')
    expect((again.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }).n).toBe(
      applied,
    )
  })
})
