/**
 * Literal patch application, shared by the HOST (replay) and the CLIENT (canvas
 * timeline fold).
 *
 * WHY THIS IS ITS OWN MODULE: a patch is the highest-frequency artifact op, and
 * its effect used to be recorded in the session log as a full copy of the
 * resulting working copy. On a real session (17 versions, 139 patches) those
 * copies were 7.87 MB of a 29.49 MB log, while the SAME patches' tool-call
 * arguments — which the log also stores — were 0.16 MB. A 49x amplification to
 * record something already recorded by its cause.
 *
 * MEASURED CONSEQUENCE, stated honestly because the first guess was wrong: the
 * saving is NOT on disk. zstd with the large window DSH uses (confirmed: wlog=20
 * reproduces its actual file size) already encodes those near-identical copies
 * almost for free — recompressing the same log with and without them moved
 * 3.97 MB to 3.92 MB, about 0%. What the copies really cost is MEMORY: parsing
 * the log into events took 193.4 MB of heap with them and 152.7 MB without, a
 * 40.7 MB (21%) saving on a fully-loaded heavy session, because JSON strings are
 * held individually and the CJK content doubles under UTF-16. Session-open
 * parsing also drops from 0.51s to 0.43s.
 *
 * So the log now carries the patch's ARGS and a small descriptor, and both
 * consumers reproduce the effect with the function below. Both sides must agree
 * EXACTLY, which is why the algorithm lives in one place instead of being
 * mirrored: a divergent copy would rebuild a different working copy than the
 * store holds, with no error to show for it.
 *
 * The semantics are deliberately literal and total:
 *  - an empty or identical `old`/`new` pair is a NO-OP (count 0), never an error;
 *  - a `old` that is absent means "nothing to do", not "fail";
 *  - `replace_all` replaces every occurrence, `!replace_all` only the first;
 *  - matching is plain `indexOf`, never a regex, so a patch containing regex
 *    metacharacters (or `$1`) is applied as written.
 * @module
 */

/** The outcome of applying one patch. */
export interface ReplaceOutcome {
  /** The patched source (unchanged when nothing matched). */
  html: string
  /** How many occurrences were replaced. */
  count: number
}

/**
 * Replace literal occurrences of one substring.
 * @param source - the source to patch.
 * @param oldString - the literal substring to find.
 * @param newString - the literal replacement.
 * @param replaceAll - replace every occurrence, or only the first.
 * @returns the patched source and how many occurrences were replaced.
 */
export function replaceOccurrences(source: string, oldString: string, newString: string, replaceAll: boolean): ReplaceOutcome {
  if (oldString.length === 0) return { html: source, count: 0 }
  if (oldString === newString) return { html: source, count: 0 }
  let count = 0
  let html = source
  if (!replaceAll) {
    const index = html.indexOf(oldString)
    if (index === -1) return { html: source, count: 0 }
    return { html: html.slice(0, index) + newString + html.slice(index + oldString.length), count: 1 }
  }
  let cursor = 0
  let out = ''
  for (;;) {
    const index = html.indexOf(oldString, cursor)
    if (index === -1) break
    out += html.slice(cursor, index) + newString
    cursor = index + oldString.length
    count++
  }
  if (count === 0) return { html: source, count: 0 }
  return { html: out + html.slice(cursor), count }
}

/** One patch as it travels in a tool call's arguments. */
export interface PatchArgs {
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * Read patch arguments out of a decoded tool-call argument object.
 *
 * Tolerant by design: a patch whose args cannot be read simply cannot be
 * REPLAYED from them, and the callers fall back to whatever content they do
 * have (an older log's projected `html`, or the on-disk working copy) rather
 * than failing the whole reconstruction.
 * @param value - the decoded tool-call arguments.
 * @returns the patch arguments, or undefined when they are not a valid patch.
 */
export function readPatchArgs(value: unknown): PatchArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.op !== 'patch') return undefined
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = record
  if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined
  return { oldString, newString, replaceAll: replaceAll === true }
}

/**
 * Build patch arguments from ALREADY-NORMALIZED fields.
 *
 * The client parses tool args through `artifactArgs`, which converts the wire's
 * snake_case to camelCase. Feeding those to {@link readPatchArgs} silently
 * yielded `undefined` (it reads the wire shape), so a sourceless patch fell back
 * to "no cause" and the canvas stopped tracking edits. Keeping the two entry
 * points separate makes each caller's shape explicit instead of accepting both
 * and guessing.
 * @param oldString - normalized old side.
 * @param newString - normalized new side.
 * @param replaceAll - normalized replace-all flag.
 * @returns the patch arguments, or undefined when either side is not a string.
 */
export function patchArgsOf(oldString: unknown, newString: unknown, replaceAll: unknown): PatchArgs | undefined {
  if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined
  return { oldString, newString, replaceAll: replaceAll === true }
}

/**
 * Apply one patch's arguments to a working copy. PURE.
 * @param html - the current working copy.
 * @param args - the patch arguments.
 * @returns the patched source and the applied count.
 */
export function applyPatch(html: string, args: PatchArgs): ReplaceOutcome {
  return replaceOccurrences(html, args.oldString, args.newString, args.replaceAll)
}

/**
 * A cheap, PURE content fingerprint (FNV-1a, 32-bit, hex).
 *
 * Used to VERIFY a replayed working copy against what the original op produced.
 * Deliberately not a cryptographic hash: this runs in the browser on every
 * patched artifact and only needs to detect divergence, not resist attack. It is
 * pure JavaScript so the host and the client compute the identical value —
 * `node:crypto` would not exist on the client side.
 * @param value - the string to fingerprint.
 * @returns eight lowercase hex digits.
 */
export function contentHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    // FNV prime (16777619) via shifts, keeping the multiply in 32-bit range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
