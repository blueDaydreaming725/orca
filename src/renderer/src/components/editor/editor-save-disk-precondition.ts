import type { OpenFile } from '@/store/slices/editor'
import {
  missingOrIdenticalPrecondition,
  type FileWriteDiskPrecondition,
  type OlderHostDiskPreconditionFallback
} from '../../../../shared/file-write-disk-precondition'

/** `user`: an explicit save (shortcut, save-and-close dialog). `restart`: the save-all before a restart. */
export type EditorSaveTrigger = 'autosave' | 'user' | 'restart'

/**
 * `written`: disk holds the text. `blocked-stale`: the host refused because disk moved on since the
 * tab's baseline. `failed`: nothing was written (read-only, suspended, superseded). Write errors reject.
 * Callers treat anything but `written` as not saved.
 */
export type EditorSaveResult = 'written' | 'blocked-stale' | 'failed'

/**
 * Compatibility fallback: a host without `files.writeIfUnchanged` takes the plain write editor
 * saves always used, so saving against an older remote keeps working (unguarded there).
 */
export const EDITOR_SAVE_OLDER_HOST_FALLBACK: OlderHostDiskPreconditionFallback = 'unguarded-write'

/**
 * The disk state a save requires, or `null` for a plain write. A guarded save is refused when disk
 * no longer holds what this tab last read or wrote, so an unnoticed external write is never overwritten.
 */
export function editorSaveDiskPrecondition(
  file: OpenFile,
  content: string,
  trigger: EditorSaveTrigger
): FileWriteDiskPrecondition | null {
  // Why: diff tabs load diff bodies, not the file, so they carry no file baseline to compare.
  if (file.mode !== 'edit') {
    return null
  }
  // Why: the banner says saving overwrites the disk version; an explicit save is that Overwrite.
  // A tab already marked deleted is recreated by an explicit save, as before.
  if (
    trigger === 'user' &&
    (file.externalMutation === 'changed' || file.externalMutation === 'deleted')
  ) {
    return null
  }
  const baseline = file.lastKnownDiskSignature
  if (baseline === undefined) {
    // Why: with no disk version known, only a missing file or one already holding this text is safe.
    return missingOrIdenticalPrecondition(content)
  }
  // Why: autosave must not resurrect a file deleted behind the editor's back; explicit saves may.
  return { expectedSignature: baseline, allowMissing: trigger !== 'autosave' }
}

const pendingBaselineRestamps = new Map<string, Promise<void>>()

/** Registers Keep My Edits' disk read so saves of that tab wait for its new baseline. */
export function trackEditorBaselineRestamp(fileId: string, restamp: Promise<void>): void {
  const tracked = restamp.catch(() => undefined)
  pendingBaselineRestamps.set(fileId, tracked)
  void tracked.then(() => {
    if (pendingBaselineRestamps.get(fileId) === tracked) {
      pendingBaselineRestamps.delete(fileId)
    }
  })
}

export function waitForEditorBaselineRestamp(fileId: string): Promise<void> {
  return pendingBaselineRestamps.get(fileId) ?? Promise.resolve()
}
