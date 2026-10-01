/*
 * Replay of a REAL session's artifact log.
 *
 * This is the most valuable kind of test for the fold: a genuine op sequence
 * with the exact meta shapes a real host produced, including the legacy ones.
 * It is opt-in because the fixture is a user's own session log — it must not be
 * committed, so CI cannot have it.
 *
 * Produce the dump with a small script that walks the session's `tool/result`
 * events and writes the artifact metas as JSON:
 *
 *   DSH_ARTIFACT_REPLAY=/path/to/events.json pnpm test
 *
 * Each entry needs at least { op, id } and, for html-bearing ops, { html }.
 * `version`/`revision`/`truncated`/`interactive`/`applied` are honored when
 * present. The synthetic legacy-shape coverage that DOES run in CI lives in
 * tests/contracts.spec.ts ("legacy meta compatibility").
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTimelines, scanArtifactEntries } from '../src/client/canvas/scan.ts'

const DUMP = process.env.DSH_ARTIFACT_REPLAY
const ARTIFACT_ID = process.env.DSH_ARTIFACT_REPLAY_ID

/**
 * Skip with a REASON rather than passing vacuously. A test that silently does
 * nothing is worse than no test: it reads as coverage while asserting nothing.
 */
const runIfFixture = DUMP !== undefined && DUMP !== '' && existsSync(DUMP)

describe('replay a real session artifact log', () => {
  it.skipIf(!runIfFixture)('folds the log into a timeline without losing checkpoints', () => {
    const events = JSON.parse(readFileSync(DUMP as string, 'utf8')) as {
      seq: number
      time?: number
      isError?: boolean
      op: string
      id: string
      version?: number
      revision?: number
      html?: string
      title?: string
      applied?: number
      truncated?: boolean
      interactive?: boolean
    }[]
    expect(events.length).toBeGreaterThan(0)

    // Feed synthetic tool-result nodes built from the dump, in the shape the
    // client's card model reads (raw `meta`, discriminated by `op`).
    const nodes = events.map(event => ({
      kind: 'tool-result',
      seq: event.seq,
      time: event.time ?? 0,
      callId: `c${event.seq}`,
      isError: event.isError,
      meta: {
        op: event.op,
        id: event.id,
        ...event.version === undefined ? {} : { version: event.version },
        ...event.revision === undefined ? {} : { revision: event.revision },
        ...event.html === undefined ? {} : { html: event.html },
        ...event.title === undefined ? {} : { title: event.title },
        ...event.applied === undefined ? {} : { applied: event.applied },
        ...event.truncated === undefined ? {} : { truncated: event.truncated },
        ...event.interactive === undefined ? {} : { interactive: event.interactive },
      },
    }))

    const timelines = buildTimelines(scanArtifactEntries(nodes))
    expect(timelines.size).toBeGreaterThan(0)

    // Pick the artifact the operator named, else the busiest one.
    const id = ARTIFACT_ID ?? [...timelines.entries()]
      .sort((a, b) => b[1].checkpoints.length - a[1].checkpoints.length)[0]![0]
    const timeline = timelines.get(id)
    expect(timeline, `no timeline for artifact ${id}`).toBeDefined()

    // Invariants that must hold for ANY real log, without baking in one
    // session's exact version count:
    const versions = timeline!.checkpoints.map(checkpoint => checkpoint.version)
    // Ascending and unique — a duplicate version would make 前进/后退 ambiguous.
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
    expect(new Set(versions).size).toBe(versions.length)
    // Never more than the server would keep.
    expect(versions.length).toBeLessThanOrEqual(20)
    // The working copy is always known once any html-bearing op was seen.
    expect(timeline!.workingHtml).toBeTypeOf('string')
    // lastSeq must be the true maximum of the entries for this artifact.
    const seqs = scanArtifactEntries(nodes).filter(entry => entry.id === id).map(entry => entry.seq)
    expect(timeline!.lastSeq).toBe(Math.max(...seqs))
  })
})