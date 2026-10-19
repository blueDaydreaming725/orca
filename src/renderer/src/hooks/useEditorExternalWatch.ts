import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import { verifyLatchedEditorMoveDestinations } from './editor-external-watch-disk-verification'
import {
  acquireWatchRoot,
  isWatchRootLive,
  markWatchRootLive,
  releaseAllWatchRoots,
  releaseWatchRoot,
  type HeldWatchRoots
} from './editor-external-watch-local-roots'
import { holdRewatchedTabs, releaseRewatchedTabs } from './editor-external-watch-rewatch-hold'

type FsChangedHandler = (
  payload: FsChangedPayload,
  runtimeEnvironmentId?: string | null,
  onlyTarget?: EditorExternalWatchTarget
) => void

function warnExternalWatchFailure(target: EditorExternalWatchTarget, err: unknown): void {
  console.warn('[filesystem-watch] failed to watch worktree', {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    error: err instanceof Error ? err.message : String(err)
  })
}

/** Keeps editor filesystem subscriptions alive beyond any individual editor surface. */
export function useEditorExternalWatch(): void {
  const snapshot = useAppStore(selectEditorExternalWatchTargets)
  const targetsRef = useRef<EditorExternalWatchTarget[]>([])
  const unwatchedTargetKeysRef = useRef<ReadonlySet<string>>(new Set())
  const remoteWatchUnsubsRef = useRef(new Map<string, () => void>())
  const heldWatchRootsRef = useRef<HeldWatchRoots>(new Map())
  const heldTabTargetKeysRef = useRef(new Set<string>())
  const fsChangedHandlerRef = useRef<FsChangedHandler | null>(null)

  // Why: diff targets so unchanged worktrees keep their subscription; full teardown on every store change drops events in the gap.
  useEffect(() => {
    const nextTargets = snapshot.targets
    const previousUnwatchedKeys = unwatchedTargetKeysRef.current
    unwatchedTargetKeysRef.current = snapshot.unwatchedTargetKeys
    const previousTargets = targetsRef.current
    const previousKeys = new Set(previousTargets.map(getEditorExternalWatchTargetKey))
    const nextKeys = new Set(nextTargets.map(getEditorExternalWatchTargetKey))
    const removed = previousTargets.filter(
      (target) => !nextKeys.has(getEditorExternalWatchTargetKey(target))
    )
    const added = nextTargets.filter(
      (target) => !previousKeys.has(getEditorExternalWatchTargetKey(target))
    )

    // Why: publish first — a runtime stream that is already ready resyncs synchronously and must find its target.
    targetsRef.current = nextTargets
    // Why: acquire before release so a root shared by an added and a removed target is never dropped in between.
    for (const target of added) {
      const key = getEditorExternalWatchTargetKey(target)
      // Why: writes made while it was unwatched (background trim) were never reported. Hold its tabs,
      // then once the watch is live resync like a reconnect does — one overflow through the normal pipeline.
      const resync = previousUnwatchedKeys.has(key)
        ? () => {
            // Why: a live signal can outlive its target (released, or re-added on a newer watch).
            const current = targetsRef.current.some(
              (candidate) => getEditorExternalWatchTargetKey(candidate) === key
            )
            if (
              !current ||
              (!target.runtimeEnvironmentId && !isWatchRootLive(heldWatchRootsRef.current, target))
            ) {
              return
            }
            heldTabTargetKeysRef.current.delete(key)
            releaseRewatchedTabs(target, true)
            fsChangedHandlerRef.current?.(
              {
                worktreePath: target.worktreePath,
                events: [{ kind: 'overflow', absolutePath: target.worktreePath }],
                connectionId: target.connectionId
              },
              target.runtimeEnvironmentId,
              target
            )
          }
        : undefined
      if (resync) {
        heldTabTargetKeysRef.current.add(key)
        holdRewatchedTabs(target)
      }
      if (target.runtimeEnvironmentId) {
        // Why: the host's ready event means its watcher is installed, so nothing after the resync is lost.
        subscribeRuntimeTarget(target, remoteWatchUnsubsRef.current, fsChangedHandlerRef, resync)
        continue
      }
      const live = acquireWatchRoot(heldWatchRootsRef.current, target, (err) => {
        // Why: SSH providers can disappear while tabs still reference the worktree; report the failure without an uncaught renderer promise.
        warnExternalWatchFailure(target, err)
      })
      if (resync) {
        void live.then(resync)
      }
    }
    for (const target of removed) {
      const key = getEditorExternalWatchTargetKey(target)
      if (heldTabTargetKeysRef.current.delete(key)) {
        releaseRewatchedTabs(target, false)
      }
      const remoteUnsubscribe = remoteWatchUnsubsRef.current.get(key)
      if (remoteUnsubscribe) {
        remoteUnsubscribe()
        remoteWatchUnsubsRef.current.delete(key)
      } else {
        releaseWatchRoot(heldWatchRootsRef.current, target)
      }
    }
    // Why: final unmount cleanup owns teardown so target changes remain differential.
    // Why: the selector keeps the snapshot identity until a target or unwatched key changes.
  }, [snapshot])

  // Why: one stable fs:changed listener prevents target-key changes from opening an event-loss gap.
  useEffect(() => {
    const remoteWatchUnsubs = remoteWatchUnsubsRef.current
    const heldWatchRoots = heldWatchRootsRef.current
    const heldTabTargetKeys = heldTabTargetKeysRef.current
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler(
      (worktreePath, runtimeEnvironmentId, connectionId) =>
        targetsRef.current.filter(
          (target) =>
            normalizeRuntimePathForComparison(target.worktreePath) ===
              normalizeRuntimePathForComparison(worktreePath) &&
            target.runtimeEnvironmentId === runtimeEnvironmentId &&
            // Why: a local and an SSH root can share a path; runtime streams are already per host.
            (runtimeEnvironmentId !== null || target.connectionId === connectionId)
        )
    )
    const unsubscribe = window.api.fs.onFsChanged((payload) => handleFsChanged(payload, null))
    const stopWatchLive = window.api.fs.onWatchLive((payload) =>
      markWatchRootLive(heldWatchRoots, payload)
    )
    fsChangedHandlerRef.current = handleFsChanged

    return () => {
      unsubscribe()
      stopWatchLive()
      dispose()
      fsChangedHandlerRef.current = null
      for (const remoteUnsubscribe of remoteWatchUnsubs.values()) {
        remoteUnsubscribe()
      }
      remoteWatchUnsubs.clear()
      releaseAllWatchRoots(heldWatchRoots)
      targetsRef.current = []
      unwatchedTargetKeysRef.current = new Set()
      heldTabTargetKeys.clear()
      // Why: module-scoped reload timers survive StrictMode's synthetic cleanup; a late reload dispatch is harmless.
    }
  }, [])
}

function subscribeRuntimeTarget(
  target: EditorExternalWatchTarget,
  remoteWatchUnsubs: Map<string, () => void>,
  fsChangedHandlerRef: { current: FsChangedHandler | null },
  onFirstReady: (() => void) | undefined
): void {
  const runtimeEnvironmentId = target.runtimeEnvironmentId
  if (!runtimeEnvironmentId) {
    return
  }
  const key = getEditorExternalWatchTargetKey(target)
  remoteWatchUnsubs.set(
    key,
    subscribeEditorRuntimeFileWatch(
      { ...target, runtimeEnvironmentId },
      (payload) => fsChangedHandlerRef.current?.(payload, runtimeEnvironmentId),
      (error) => warnExternalWatchFailure(target, error),
      onFirstReady
    )
  )
}

export function verifyLatchedMoveDestinations(
  ...args: Parameters<typeof verifyLatchedEditorMoveDestinations>
): void {
  verifyLatchedEditorMoveDestinations(...args)
}
