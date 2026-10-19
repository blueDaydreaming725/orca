// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
}

const harness = vi.hoisted(() => {
  const targets: TestWatchTarget[] = []
  const unwatched: TestWatchTarget[] = []
  const holder: { store: { getState: () => unknown } | null } = { store: null }
  return {
    keyOf: (target: TestWatchTarget): string => `${target.worktreeId}::client`,
    targets,
    unwatched,
    holder,
    readRuntimeFileContent: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(harness.holder.store?.getState()),
    { getState: () => harness.holder.store?.getState() }
  )
}))
vi.mock('./editor-external-watch-targets', () => ({
  selectEditorExternalWatchTargets: () => ({
    targets: [...harness.targets],
    targetsKey: harness.targets.map(harness.keyOf).join('|'),
    unwatchedTargetKeys: new Set(harness.unwatched.map(harness.keyOf)),
    unwatchedTargetsKey: harness.unwatched.map(harness.keyOf).join('|')
  }),
  getEditorExternalWatchTargetKey: harness.keyOf,
  getOpenFileRuntimeOwner: (file: { runtimeEnvironmentId?: string }) =>
    file.runtimeEnvironmentId?.trim() || null,
  getLocalWindowsWslAliasOption: () => ({})
}))
vi.mock('./editor-external-watch-event-reconciliation', () => ({
  buildEditorExternalWatchEventHandler: () => ({ handleFsChanged: vi.fn(), dispose: vi.fn() })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  verifyLatchedEditorMoveDestinations: vi.fn()
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: harness.readRuntimeFileContent
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

import { createTestStore } from '@/store/slices/store-test-helpers'
import { useEditorExternalWatch } from './useEditorExternalWatch'
import { attachRestoredTabConflictScan } from '@/components/editor/editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import { isAutosaveSuspendedForFile } from '@/components/editor/editor-autosave'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

const active: TestWatchTarget = {
  worktreeId: 'active',
  worktreePath: '/active',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const background: TestWatchTarget = {
  worktreeId: 'background',
  worktreePath: '/background',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const FILE = '/background/a.ts'

describe('editing a stale tab right after its workspace is watched again', () => {
  let store: ReturnType<typeof createTestStore>
  let container: HTMLDivElement
  let root: Root
  let previousApi: unknown
  let detachScan: () => void
  let settleWatch: (status: 'installed' | 'pending') => void
  let emitWatchLive: (payload: { worktreePath: string; connectionId?: string }) => void

  const file = () => store.getState().openFiles.find((f) => f.id === FILE)!

  async function render(targets: TestWatchTarget[], unwatched: TestWatchTarget[]): Promise<void> {
    harness.targets.splice(0, harness.targets.length, ...targets)
    harness.unwatched.splice(0, harness.unwatched.length, ...unwatched)
    await act(async () => root.render(createElement(WatchProbe)))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    store = createTestStore()
    harness.holder.store = store
    store.getState().openFile({
      filePath: FILE,
      relativePath: 'a.ts',
      worktreeId: 'background',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setLastKnownDiskSignature(FILE, getDiskBaselineSignature('v1'))
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: {
        // Why: the watch is still installing, so the resync has not landed when the user types.
        watchWorktree: vi.fn(
          () =>
            new Promise<'installed' | 'pending'>((resolve) => {
              settleWatch = resolve
            })
        ),
        unwatchWorktree: vi.fn().mockResolvedValue(undefined),
        onFsChanged: vi.fn(() => vi.fn()),
        onWatchLive: vi.fn(
          (listener: (payload: { worktreePath: string; connectionId?: string }) => void) => {
            emitWatchLive = listener
            return vi.fn()
          }
        ),
        pathExists: vi.fn().mockResolvedValue(true)
      }
    }
    detachScan = attachRestoredTabConflictScan(store)
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    detachScan()
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  async function switchBackAndType(): Promise<void> {
    await render([active], [background])
    await render([active, background], [])
    store.getState().setEditorDraft(FILE, 'typed on the stale buffer')
    store.getState().markFileDirty(FILE, true)
    await act(async () => {})
  }

  it('holds autosave and shows changed-on-disk when the file changed while unwatched', async () => {
    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v2 agent write', isBinary: false })
    await switchBackAndType()

    expect(file().externalMutation).toBe('changed')
    expect(isAutosaveSuspendedForFile(file())).toBe(true)
  })

  it('keeps autosave held until the watch is live, then re-checks disk', async () => {
    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v1', isBinary: false })
    await switchBackAndType()
    // Why: disk still matched, but a write can land before the watch is live, so the hold stays.
    expect(file().pendingDiskBaselineVerification).toBeFalsy()
    expect(isAutosaveSuspendedForFile(file())).toBe(true)

    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v2 agent write', isBinary: false })
    await act(async () => settleWatch('installed'))
    expect(file().pendingWatchReady).toBeFalsy()
    expect(file().externalMutation).toBe('changed')
  })

  it('stays held while install is pending and recovers on a later live signal', async () => {
    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v1', isBinary: false })
    await switchBackAndType()
    await act(async () => settleWatch('pending'))
    expect(isAutosaveSuspendedForFile(file())).toBe(true)

    await act(async () => emitWatchLive({ worktreePath: '/background' }))
    expect(file().externalMutation).toBeUndefined()
    expect(isAutosaveSuspendedForFile(file())).toBe(false)
  })

  it('releases the hold when the workspace is dropped again before going live', async () => {
    await render([active], [background])
    await render([active, background], [])
    expect(file().pendingWatchReady).toBe(true)

    await render([active], [background])
    expect(file().pendingWatchReady).toBeFalsy()
  })

  it('leaves tabs of a freshly opened workspace alone', async () => {
    await render([active], [])
    await render([active, background], [])

    expect(file().pendingDiskBaselineVerification).toBeFalsy()
    expect(file().pendingWatchReady).toBeFalsy()
  })
})
