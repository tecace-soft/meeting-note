import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  projects: { data: [] as unknown[] | null, error: null as unknown },
  queryCalls: [] as unknown[][],
  rpc: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('../../../config/supabaseConfig', () => {
  h.rpc = vi.fn();
  return {
    supabase: {
      from: (table: string) => {
        const calls: unknown[] = [table];
        h.queryCalls.push(calls);
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'order']) {
          q[m] = (...a: unknown[]) => {
            calls.push([m, ...a]);
            return q;
          };
        }
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve(h.projects).then(ok);
        return q;
      },
      rpc: (...a: unknown[]) => h.rpc(...a),
    },
  };
});

import { useAddToProject, type ProjectOption } from './useAddToProject';
import type { Note } from '../types';

const N1: Note = { id: 'n1', name: 'Alpha', user_id: 'u1', user_name: 'Me', projects: ['p1'] };
const N2: Note = { id: 'n2', name: 'Beta', user_id: 'u1', user_name: 'Me' };
const P1: ProjectOption = { id: 'p1', name: 'One', notes: ['n1'] };
const P2: ProjectOption = { id: '2', name: 'Two', notes: [9] };

function setup(userIdArg: string | null = 'u1') {
  const userId = userIdArg ?? undefined;
  const closeNoteMenu = vi.fn();
  const view = renderHook(() => {
    const [notes, setNotes] = useState<Note[]>([N1, N2]);
    const add = useAddToProject({ userId, setNotes, closeNoteMenu });
    return { notes, add };
  });
  return { ...view, closeNoteMenu };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  h.projects.data = [P1, P2];
  h.projects.error = null;
  h.queryCalls.length = 0;
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useAddToProject open', () => {
  it('closes the menu, targets the note, shows loading, then lists projects by name', async () => {
    const { result, closeNoteMenu } = setup();
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.add.openAddToProject(N2);
    });
    expect(closeNoteMenu).toHaveBeenCalled();
    expect(result.current.add.addToProjectNote).toBe(N2);
    expect(result.current.add.projectsLoading).toBe(true);
    await act(async () => opening);
    expect(result.current.add.projectsLoading).toBe(false);
    expect(result.current.add.projectOptions).toEqual([P1, P2]);
    expect(h.queryCalls[0]).toEqual(['project', ['select', 'id, name, notes'], ['order', 'name', { ascending: true }]]);
  });

  it('without a user it opens but does not query', async () => {
    const { result } = setup(null);
    await act(async () => result.current.add.openAddToProject(N2));
    expect(result.current.add.addToProjectNote).toBe(N2);
    expect(h.queryCalls).toEqual([]);
  });

  it('reports an Error message or the generic one when loading fails, and empties the list', async () => {
    h.projects.error = new Error('down');
    const first = setup();
    await act(async () => first.result.current.add.openAddToProject(N2));
    expect(first.result.current.add.addToProjectError).toBe('down');
    expect(first.result.current.add.projectOptions).toEqual([]);
    h.projects.error = { message: 'raw' };
    const second = setup();
    await act(async () => second.result.current.add.openAddToProject(N2));
    expect(second.result.current.add.addToProjectError).toBe('Failed to load projects');
  });

  it('closeAddToProject clears the target', async () => {
    const { result } = setup();
    await act(async () => result.current.add.openAddToProject(N2));
    act(() => result.current.add.closeAddToProject());
    expect(result.current.add.addToProjectNote).toBeNull();
  });
});

describe('useAddToProject add', () => {
  it('calls the rpc, applies the project to the note and the project list, and closes', async () => {
    const d = deferred<{ data: null; error: null }>();
    h.rpc.mockReturnValue(d.promise);
    const { result } = setup();
    await act(async () => result.current.add.openAddToProject(N2));
    let adding!: Promise<void>;
    act(() => {
      adding = result.current.add.addNoteToProject(P2);
    });
    expect(result.current.add.addToProjectSavingId).toBe('2');
    await act(async () => {
      d.resolve({ data: null, error: null });
      await adding;
    });
    expect(h.rpc).toHaveBeenCalledWith('add_accessible_note_to_project', { p_note_id: 'n2', p_project_id: '2' });
    expect(result.current.notes[1].projects).toEqual([2]);
    expect(result.current.add.projectOptions.find((p) => p.id === '2')!.notes).toEqual([9, 'n2']);
    expect(result.current.add.addToProjectNote).toBeNull();
    expect(result.current.add.addToProjectSavingId).toBeNull();
  });

  it('does nothing when the note is already in the project or there is no target or user', async () => {
    const { result } = setup();
    await act(async () => result.current.add.addNoteToProject(P1));
    expect(h.rpc).not.toHaveBeenCalled();
    await act(async () => result.current.add.openAddToProject(N1));
    await act(async () => result.current.add.addNoteToProject(P1));
    expect(h.rpc).not.toHaveBeenCalled();
    const noUser = setup(null);
    await act(async () => noUser.result.current.add.openAddToProject(N2));
    await act(async () => noUser.result.current.add.addNoteToProject(P2));
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the rpc error, using Error, object message or the fallback', async () => {
    const { result } = setup();
    await act(async () => result.current.add.openAddToProject(N2));
    h.rpc.mockResolvedValueOnce({ data: null, error: new Error('err') });
    await act(async () => result.current.add.addNoteToProject(P2));
    expect(result.current.add.addToProjectError).toBe('err');
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'obj' } });
    await act(async () => result.current.add.addNoteToProject(P2));
    expect(result.current.add.addToProjectError).toBe('obj');
    h.rpc.mockResolvedValueOnce({ data: null, error: {} });
    await act(async () => result.current.add.addNoteToProject(P2));
    expect(result.current.add.addToProjectError).toBe('Failed to add note to project');
    expect(result.current.add.addToProjectNote).toBe(N2);
    expect(result.current.add.addToProjectSavingId).toBeNull();
    expect(result.current.notes[1].projects).toBeUndefined();
  });

  it('ignores an add that resolves after unmount without errors', async () => {
    const d = deferred<{ data: null; error: null }>();
    h.rpc.mockReturnValue(d.promise);
    const { result, unmount } = setup();
    await act(async () => result.current.add.openAddToProject(N2));
    let adding!: Promise<void>;
    act(() => {
      adding = result.current.add.addNoteToProject(P2);
    });
    unmount();
    await act(async () => {
      d.resolve({ data: null, error: null });
      await adding;
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});
