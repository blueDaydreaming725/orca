import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { canAutoSaveOpenFile } from '@/components/editor/editor-autosave'
import {
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'

function isTargetTab(file: OpenFile, target: EditorExternalWatchTarget): boolean {
  return (
    file.worktreeId === target.worktreeId &&
    getOpenFileRuntimeOwner(file) === target.runtimeEnvironmentId
  )
}

/**
 * Tabs of a re-watched workspace may show content that changed while unwatched. Hand them to the
 * restored-tab conflict scan: it ignores clean tabs, so this only bites once the user edits one,
 * and then autosave waits for a disk-vs-baseline check (banner on mismatch).
 */
function armDiskChecks(target: EditorExternalWatchTarget): void {
  const state = useAppStore.getState()
  for (const file of state.openFiles) {
    // Why: mirror the scan's eligibility, or a tab it skips would keep autosave suspended forever.
    if (
      isTargetTab(file, target) &&
      file.lastKnownDiskSignature &&
      file.externalMutation !== 'changed' &&
      canAutoSaveOpenFile(file)
    ) {
      state.setPendingDiskBaselineVerification(file.id, true)
    }
  }
}

/** Holds autosave on the workspace's tabs until its watch is live: a disk check that passes earlier can't vouch for writes before then. */
export function holdRewatchedTabs(target: EditorExternalWatchTarget): void {
  armDiskChecks(target)
  const state = useAppStore.getState()
  state.setPendingWatchReady(
    state.openFiles
      .filter((file) => isTargetTab(file, target) && canAutoSaveOpenFile(file))
      .map((file) => file.id),
    true
  )
}

/** Watch is live (or the workspace went away): release the hold; when live, re-check disk so a change during the gap shows the banner. */
export function releaseRewatchedTabs(target: EditorExternalWatchTarget, recheck: boolean): void {
  if (recheck) {
    armDiskChecks(target)
  }
  const state = useAppStore.getState()
  state.setPendingWatchReady(
    state.openFiles.filter((file) => isTargetTab(file, target)).map((file) => file.id),
    false
  )
}
