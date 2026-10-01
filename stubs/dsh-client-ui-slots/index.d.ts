/**
 * Minimal local type seat for @deepseek-ai/dsh-client-ui-slots.
 *
 * The installed DSH CLI's client packages augment these interfaces via
 * `declare module '@deepseek-ai/dsh-client-ui-slots'` blocks (the runtime adds
 * the standard-props members; ui-layout / ui-conversation / ui-tool add their
 * SlotMap keys). Declaring the empty seats here keeps every augmentation
 * merged deterministically for plugin typechecks without publishing the real
 * package. Interface members are added exclusively by the augmenting
 * packages — keep them EMPTY.
 */

/** The slot registry's declaration map: keys are added by UI plugins. */
export interface SlotMap {
}

/** Standard kit injected into session-scoped slot components. */
export interface SessionStandardProps {
}

/** Standard kit for slots mounted across current-session changes. */
export interface SessionMaybeStandardProps {
}

/** Props injected into every global (root-scope) slot component. */
export interface GlobalStandardProps {
}

/** Props injected into keyed-slot components (key dispatch currency). */
export interface KeyedStandardProps {
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject(name: string, generator: () => Generator<any, void, unknown>): () => void
      register(descriptor: Record<string, unknown>, component?: unknown): any
    }
  }
}
