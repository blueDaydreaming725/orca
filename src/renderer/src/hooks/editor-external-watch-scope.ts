import type { AppState } from '@/store'
import { getWorktreeIdFromVisitKey } from '@/lib/worktree-visit-recency'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import {
  getDefaultMarkdownViewMode,
  getMarkdownViewModes
} from '@/components/editor/markdown-preview-controls'

// Why: recently used workspaces keep their watch so switching back needs no reload.
export const WARM_RECURSIVE_WATCH_WORKSPACE_COUNT = 3

// Why: unhydrated settings (null) keep today's watch-every-tab behaviour.
export function isBackgroundWatchTrimEnabled(settings: AppState['settings']): boolean {
  return settings?.trimBackgroundWorkspaceWatches === true
}

// Why: saves are disk-checked only through the shared Monaco text model; rich markdown, CSV and
// notebook editors and editable diffs write without that check, so their content must stay live.
function hasUncheckedEditSurface(
  file: OpenFile,
  markdownViewMode: Readonly<Record<string, MarkdownViewMode>> | undefined
): boolean {
  if (file.readOnly === true || file.csvPreviewOnly === true) {
    return false
  }
  if (file.mode === 'diff') {
    return file.diffSource === 'unstaged' || !!file.diffSource?.startsWith('combined-')
  }
  if (file.mode !== 'edit' || file.language === 'mermaid') {
    return false
  }
  const modes = getMarkdownViewModes(file)
  const stored = markdownViewMode?.[file.id]
  const viewMode = stored && modes.includes(stored) ? stored : getDefaultMarkdownViewMode(file)
  return viewMode === 'rich'
}

/** Workspaces whose open tabs keep a watch: active, the warm LRU, unsaved edits, and edit surfaces saved without a disk check. */
export function selectWatchEligibleWorkspaceIds(args: {
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>> | undefined
  openFiles: AppState['openFiles']
  markdownViewMode?: Readonly<Record<string, MarkdownViewMode>>
  exists: (workspaceId: string) => boolean
}): ReadonlySet<string> {
  const ids = new Set<string>()
  if (args.activeWorktreeId) {
    ids.add(args.activeWorktreeId)
  }
  // Why: edits normally happen only in the active workspace; a rare background edit (mobile) just adds a watch, and the rewatch re-check covers what it missed.
  // Deleted/renamed tabs stay watched too: a resync overflow clears those marks and reloads into a
  // read error, erasing the warning and last content.
  for (const file of args.openFiles) {
    if (
      (file.isDirty && !isVirtualEditorFile(file)) ||
      hasUncheckedEditSurface(file, args.markdownViewMode) ||
      file.externalMutation === 'deleted' ||
      file.externalMutation === 'renamed'
    ) {
      ids.add(file.worktreeId)
    }
  }
  // Why top-k instead of a full sort: the visit map grows with history.
  const warm: { id: string; visitedAt: number }[] = []
  for (const [key, visitedAt] of Object.entries(args.lastVisitedAtByWorktreeId ?? {})) {
    const id = getWorktreeIdFromVisitKey(key)
    // Why: `exists` keeps deleted workspaces from holding warm slots.
    if (id === args.activeWorktreeId || !args.exists(id)) {
      continue
    }
    const existing = warm.find((entry) => entry.id === id)
    if (existing) {
      existing.visitedAt = Math.max(existing.visitedAt, visitedAt)
    } else {
      warm.push({ id, visitedAt })
    }
    warm.sort((left, right) => right.visitedAt - left.visitedAt)
    warm.length = Math.min(warm.length, WARM_RECURSIVE_WATCH_WORKSPACE_COUNT)
  }
  for (const entry of warm) {
    ids.add(entry.id)
  }
  return ids
}
