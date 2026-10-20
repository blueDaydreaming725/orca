import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { keepTabEditsOverExternalChange } from './ExternalFileChangeBanner'
import {
  getDiskBaselineSignature,
  getWrittenContentDiskSignature
} from '../../../../shared/disk-baseline-signature'
import {
  compareDiskWritePrecondition,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  type FileWriteDiskPrecondition
} from '../../../../shared/file-write-disk-precondition'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn(),
  readRuntimeFileContent: vi.fn()
}))
const storeRef = vi.hoisted((): { current: ReturnType<typeof createEditorStore> | null } => ({
  current: null
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

const PATH = '/repo/file.ts'

type WriteArgs = {
  filePath: string
  content: string
  diskPrecondition?: FileWriteDiskPrecondition
  olderHostFallback?: string
}

/** A local host that compares the precondition inside the write, like the real writer. */
function stubGuardedDisk(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  const writeFile = vi.fn(async ({ filePath, content, diskPrecondition }: WriteArgs) => {
    if (diskPrecondition) {
      const diskConflict = compareDiskWritePrecondition(
        diskPrecondition,
        files.get(filePath) ?? null
      )
      if (diskConflict) {
        return { ok: false, diskConflict }
      }
    }
    files.set(filePath, content)
    return { ok: true }
  })
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: { fs: { writeFile } }
  })
  return { files, writeFile }
}

function openFile(
  store: ReturnType<typeof createEditorStore>,
  options: { baseline?: string; draft: string; filePath?: string; language?: string }
): string {
  const filePath = options.filePath ?? PATH
  store.getState().openFile({
    filePath,
    relativePath: filePath.slice('/repo/'.length),
    worktreeId: 'wt-1',
    language: options.language ?? 'typescript',
    mode: 'edit'
  })
  if (options.baseline !== undefined) {
    store.getState().setLastKnownDiskSignature(filePath, getDiskBaselineSignature(options.baseline))
  }
  store.getState().setEditorDraft(filePath, options.draft)
  store.getState().markFileDirty(filePath, true)
  return filePath
}

async function requestRestartSave(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
        detail: { claim: () => undefined, resolve, reject: (m: string) => reject(new Error(m)) }
      })
    )
  })
}

describe('editor saves guarded by the disk precondition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('blocks an autosave over an unnoticed agent write and raises the banner', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'original' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })
    // An agent rewrites the file; no watcher event reaches the editor (workspace not watched).
    disk.files.set(PATH, 'agent rewrite')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'user edit',
          diskPrecondition: {
            expectedSignature: getDiskBaselineSignature('original'),
            allowMissing: false
          },
          olderHostFallback: 'unguarded-write'
        })
      )
      expect(disk.files.get(PATH)).toBe('agent rewrite')
      const file = store.getState().openFiles[0]
      expect(file?.externalMutation).toBe('changed')
      expect(file?.isDirty).toBe(true)
      expect(store.getState().editorDrafts[PATH]).toBe('user edit')

      // The banner pauses autosave, so no retry loop follows.
      store.getState().setEditorDraft(PATH, 'user edit 2')
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.writeFile).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('rejects an explicit save over an unnoticed change, then overwrites once the banner shows', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'agent rewrite' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: PATH })).rejects.toThrow(/changed on disk/)
      expect(disk.files.get(PATH)).toBe('agent rewrite')
      expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')

      // Saving with the banner up is the overwrite choice: a plain write.
      await requestEditorFileSave({ fileId: PATH })
      expect(disk.writeFile).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ diskPrecondition: expect.anything() })
      )
      expect(disk.files.get(PATH)).toBe('user edit')
      const file = store.getState().openFiles[0]
      expect(file?.externalMutation).toBeUndefined()
      expect(file?.isDirty).toBe(false)
      expect(file?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('user edit'))
    } finally {
      cleanup()
    }
  })

  it('rebaselines to what the write left on disk, so the next save passes', async () => {
    // A lone surrogate is written as U+FFFD, so the baseline must describe that, not the buffer.
    const draft = 'a\uD800b'
    const disk = stubGuardedDisk({ [PATH]: 'original' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: PATH })
      expect(store.getState().openFiles[0]?.lastKnownDiskSignature).toBe(
        getWrittenContentDiskSignature(draft)
      )
      disk.files.set(PATH, 'a�b')

      store.getState().setEditorDraft(PATH, 'second edit')
      store.getState().markFileDirty(PATH, true)
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.writeFile).toHaveBeenCalledTimes(2)
      expect(disk.files.get(PATH)).toBe('second edit')
      expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('saves a file with no known disk version only where none exists yet', async () => {
    const newPath = '/repo/new.ts'
    const takenPath = '/repo/taken.ts'
    const disk = stubGuardedDisk({ [takenPath]: 'someone else' })
    const store = createEditorStore()
    openFile(store, { filePath: newPath, draft: 'fresh' })
    openFile(store, { filePath: takenPath, draft: 'mine' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: newPath })
      expect(disk.writeFile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          diskPrecondition: {
            expectedSignature: getWrittenContentDiskSignature('fresh'),
            allowMissing: true
          }
        })
      )
      expect(disk.files.get(newPath)).toBe('fresh')

      await expect(requestEditorFileSave({ fileId: takenPath })).rejects.toThrow(/changed on disk/)
      expect(disk.files.get(takenPath)).toBe('someone else')
      expect(store.getState().openFiles.find((f) => f.id === takenPath)?.externalMutation).toBe(
        'changed'
      )
    } finally {
      cleanup()
    }
  })

  it('does not let autosave recreate a file deleted behind the editor', async () => {
    const disk = stubGuardedDisk({})
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(disk.files.has(PATH)).toBe(false)
      expect(store.getState().openFiles[0]?.externalMutation).toBe('deleted')

      await requestEditorFileSave({ fileId: PATH })
      expect(disk.files.get(PATH)).toBe('user edit')
    } finally {
      cleanup()
    }
  })

  it('keeps the restart save guarded even while the banner shows', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'agent rewrite' })
    const store = createEditorStore()
    openFile(store, { baseline: 'original', draft: 'user edit' })
    store.getState().setExternalMutation(PATH, 'changed')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestRestartSave()).rejects.toThrow(/not saved/)
      expect(disk.files.get(PATH)).toBe('agent rewrite')
    } finally {
      cleanup()
    }
  })

  it('guards rich markdown, notebook and CSV saves the same way', async () => {
    const paths = ['/repo/a.md', '/repo/b.ipynb', '/repo/c.csv']
    const disk = stubGuardedDisk(Object.fromEntries(paths.map((path) => [path, 'agent rewrite'])))
    const store = createEditorStore()
    for (const filePath of paths) {
      openFile(store, { filePath, baseline: 'original', draft: 'user edit' })
    }

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.writeFile).toHaveBeenCalledTimes(3)
      for (const filePath of paths) {
        expect(disk.files.get(filePath)).toBe('agent rewrite')
        expect(
          store.getState().openFiles.find((f) => f.filePath === filePath)?.externalMutation
        ).toBe('changed')
      }
    } finally {
      cleanup()
    }
  })

  it('blocks the second of two tabs of one file that both save', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'original' })
    const store = createEditorStore()
    const first = openFile(store, { baseline: 'original', draft: 'first tab' })
    const secondTab = { ...store.getState().openFiles[0]!, id: 'second-tab' }
    store.setState({ openFiles: [...store.getState().openFiles, secondTab] })
    store.getState().setEditorDraft('second-tab', 'second tab')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: first })
      await expect(requestEditorFileSave({ fileId: 'second-tab' })).rejects.toThrow(
        /changed on disk/
      )

      expect(disk.files.get(PATH)).toBe('first tab')
      const second = store.getState().openFiles.find((f) => f.id === 'second-tab')
      expect(second?.externalMutation).toBe('changed')
      expect(second?.isDirty).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('makes a save after Keep My Edits wait for the restamped baseline', async () => {
    const disk = stubGuardedDisk({ [PATH]: 'agent rewrite' })
    const store = createEditorStore()
    storeRef.current = store
    openFile(store, { baseline: 'original', draft: 'user edit' })
    store.getState().setExternalMutation(PATH, 'changed')
    let finishRead: (content: string) => void = () => undefined
    mocks.readRuntimeFileContent.mockReturnValue(
      new Promise((resolve) => {
        finishRead = (content) => resolve({ content, isBinary: false })
      })
    )

    const cleanup = attachEditorAutosaveController(store)
    try {
      keepTabEditsOverExternalChange(store.getState().openFiles[0]!)
      const save = requestEditorFileSave({ fileId: PATH })
      await vi.advanceTimersByTimeAsync(0)
      expect(disk.writeFile).not.toHaveBeenCalled()

      finishRead('agent rewrite')
      await save
      expect(disk.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          diskPrecondition: {
            expectedSignature: getDiskBaselineSignature('agent rewrite'),
            allowMissing: true
          }
        })
      )
      expect(disk.files.get(PATH)).toBe('user edit')
    } finally {
      cleanup()
    }
  })
})

describe('editor saves through a remote host without the guarded write', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('falls back to the plain write instead of refusing the save', async () => {
    clearRuntimeCompatibilityCacheForTests()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
    const status = createCompatibleRuntimeStatusResponse('runtime-env-1')
    if (!status.ok) {
      throw new Error('fixture status must succeed')
    }
    const capabilities = (status.result.capabilities ?? []).filter(
      (capability) => capability !== FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY
    )
    const olderStatus = { ...status, result: { ...status.result, capabilities } }
    const runtimeCall = vi.fn((args: RuntimeEnvironmentCallRequest) =>
      Promise.resolve(
        args.method === 'status.get'
          ? olderStatus
          : { ok: true, result: { ok: true }, _meta: { runtimeId: 'runtime-env-1' } }
      )
    )
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: { fs: { writeFile: vi.fn() }, runtimeEnvironments: { call: runtimeCall } }
    })
    const store = createEditorStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' })]
      }
    })
    store.getState().openFile({
      filePath: '/remote/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-1',
      language: 'typescript',
      mode: 'edit'
    })
    store
      .getState()
      .setLastKnownDiskSignature('/remote/repo/file.ts', getDiskBaselineSignature('original'))
    store.getState().setEditorDraft('/remote/repo/file.ts', 'edited')
    store.getState().markFileDirty('/remote/repo/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: '/remote/repo/file.ts' })

      const methods = runtimeCall.mock.calls.map(([args]) => args.method)
      expect(methods).toContain('files.write')
      expect(methods).not.toContain('files.writeIfUnchanged')
      expect(methods).not.toContain('files.read')
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })
})
