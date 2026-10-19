import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { WatchLivePayload } from '../../../shared/filesystem-entry-types'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

type WatchRootArgs = { worktreePath: string; connectionId: string | undefined }

type HeldWatchRoot = {
  args: WatchRootArgs
  consumers: number
  failed: boolean
  live: boolean
  /** Settles once main reports the watch installed, from the request or a later retry. */
  whenLive: Promise<void>
  markLive: () => void
}

/** Local and SSH watch roots held by this renderer, counted per physical root. */
export type HeldWatchRoots = Map<string, HeldWatchRoot>

// Why: main keeps one listener per renderer and root, so two workspace ids on one directory must share one watch.
function getWatchRootKey(target: { worktreePath: string; connectionId?: string }): string {
  return `${target.connectionId ?? 'local'}::${normalizeRuntimePathForComparison(target.worktreePath)}`
}

/** Returns a promise that settles when the root's watch is live; it stays pending while install keeps failing. */
export function acquireWatchRoot(
  roots: HeldWatchRoots,
  target: EditorExternalWatchTarget,
  onError: (error: unknown) => void
): Promise<void> {
  const key = getWatchRootKey(target)
  const held = roots.get(key)
  if (held) {
    held.consumers += 1
    // Why: a failed request is not a watch; the next workspace to need this root retries it.
    if (held.failed) {
      requestWatch(held, onError)
    }
    return held.whenLive
  }
  let resolveLive!: () => void
  const root: HeldWatchRoot = {
    args: { worktreePath: target.worktreePath, connectionId: target.connectionId },
    consumers: 1,
    failed: false,
    live: false,
    whenLive: new Promise<void>((resolve) => {
      resolveLive = resolve
    }),
    markLive: () => {
      root.live = true
      resolveLive()
    }
  }
  roots.set(key, root)
  requestWatch(root, onError)
  return root.whenLive
}

function requestWatch(root: HeldWatchRoot, onError: (error: unknown) => void): void {
  root.failed = false
  window.api.fs.watchWorktree(root.args).then(
    (status) => {
      // Why: hosts that predate the status resolve with nothing, which only happens once installed.
      if (status !== 'pending') {
        root.markLive()
      }
    },
    (error: unknown) => {
      root.failed = true
      onError(error)
    }
  )
}

/** A capacity wait or SSH retry installed the root after its request returned 'pending'. */
export function markWatchRootLive(roots: HeldWatchRoots, payload: WatchLivePayload): void {
  roots.get(getWatchRootKey(payload))?.markLive()
}

export function isWatchRootLive(roots: HeldWatchRoots, target: EditorExternalWatchTarget): boolean {
  return roots.get(getWatchRootKey(target))?.live === true
}

export function releaseWatchRoot(roots: HeldWatchRoots, target: EditorExternalWatchTarget): void {
  const key = getWatchRootKey(target)
  const held = roots.get(key)
  if (!held) {
    return
  }
  held.consumers -= 1
  if (held.consumers > 0) {
    return
  }
  roots.delete(key)
  void window.api.fs.unwatchWorktree(held.args)
}

export function releaseAllWatchRoots(roots: HeldWatchRoots): void {
  for (const held of roots.values()) {
    void window.api.fs.unwatchWorktree(held.args)
  }
  roots.clear()
}
