import type { WebContents } from 'electron'
import type { WatchLivePayload } from '../../shared/filesystem-entry-types'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot, getRemoteWatcherKey } from './filesystem-watcher-paths'
import { isCurrentWatcherSender } from './filesystem-watcher-sender-lifetime'

// Why: only renderers told 'pending' wait for a live signal, so only they get one; the sender
// signal scopes a wait to the document that asked, since a reload reuses the sender id.
const awaitingLiveBySender = new Map<number, Map<string, AbortSignal>>()

function watchKey(payload: WatchLivePayload): string {
  return payload.connectionId
    ? getRemoteWatcherKey(payload.connectionId, payload.worktreePath)
    : getLocalWatcherRoot(payload.worktreePath).key
}

export function noteWatchAwaitingLive(
  sender: WebContents,
  senderSignal: AbortSignal,
  payload: WatchLivePayload
): void {
  let keys = awaitingLiveBySender.get(sender.id)
  if (!keys) {
    keys = new Map()
    awaitingLiveBySender.set(sender.id, keys)
  }
  keys.set(watchKey(payload), senderSignal)
}

export function forgetWatchAwaitingLive(senderId: number, payload: WatchLivePayload): void {
  const keys = awaitingLiveBySender.get(senderId)
  keys?.delete(watchKey(payload))
  if (keys?.size === 0) {
    awaitingLiveBySender.delete(senderId)
  }
}

/** Tells a renderer that was told 'pending' that its watch on this root is now live. */
export function announceWatchLive(sender: WebContents, payload: WatchLivePayload): void {
  const signal = awaitingLiveBySender.get(sender.id)?.get(watchKey(payload))
  if (!signal) {
    return
  }
  forgetWatchAwaitingLive(sender.id, payload)
  if (!isCurrentWatcherSender(sender, signal)) {
    return
  }
  try {
    sender.send('fs:watchLive', payload)
  } catch (error) {
    console.warn('[filesystem-watcher] failed to announce live watch', error)
  }
}

export function isLocalWatchLiveFor(worktreePath: string, senderId: number): boolean {
  const { key } = getLocalWatcherRoot(worktreePath)
  return watcherLifecycleState.watchedRoots.get(key)?.listeners.has(senderId) === true
}
