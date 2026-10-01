import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { scanArtifactEntries, buildTimelines } from '../src/client/canvas/scan.ts'

describe('replay real user session art-vvvefq', () => {
  const testFn = existsSync('/tmp/vvvefq_events.json') ? it : it.skip
  testFn('ends at clean working copy after the revert to v7', () => {
    const events = JSON.parse(readFileSync('/tmp/vvvefq_events.json', 'utf8')) as any[]
    // scanArtifactEntries takes conversation nodes; feed synthetic tool-result nodes
    const nodes = events.map(e => ({
      kind: 'tool-result', seq: e.seq, time: e.time ?? 0, callId: 'c' + e.seq, isError: e.isError,
      resultView: { card: 'artifact', op: e.op, id: e.id, ...(e.version != null ? { version: e.version } : {}), ...(e.html != null ? { html: e.html } : {}), ...(e.title ? { title: e.title } : {}), ...(e.applied != null ? { applied: e.applied } : {}), ...(e.truncated != null ? { truncated: e.truncated } : {}), ...(e.interactive != null ? { interactive: e.interactive } : {}) },
    }))
    const entries = scanArtifactEntries(nodes as any)
    const tl = buildTimelines(entries).get('art-vvvefq')!
    console.log('checkpoints:', tl.checkpoints.map(c => c.version))
    console.log('workingDirty:', tl.workingDirty, 'workingHtml==v7 save?', tl.workingHtml === tl.checkpoints.find(c => c.version === 7)!.html)
    expect(tl.checkpoints.map(c => c.version)).toEqual([1,2,3,4,5,6,7,8])
    expect(tl.workingDirty).toBe(false)
    expect(tl.workingHtml).toBe(tl.checkpoints.find(c => c.version === 7)!.html)
  })
})
