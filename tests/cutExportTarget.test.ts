import { describe, expect, it } from 'vitest';
import { BufferTarget, StreamTarget } from 'mediabunny';
import { createCutExportTarget, CUT_EXPORT_DIR, CUT_EXPORT_STALE_MS } from '../services/cut/exportTarget';

/** 内存里的假 OPFS：只实现导出用到的几个方法，写入按 { type: 'write', position, data } 落到字节数组。 */
function fakeOpfs(existing: string[] = []) {
  const files = new Map<string, Uint8Array>(existing.map(name => [name, new Uint8Array([1])]));
  const dirs: string[] = [];
  const dir = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new Error('NotFound');
        files.set(name, new Uint8Array());
      }
      return {
        getFile: async () => new File([files.get(name)! as BlobPart], name),
        createWritable: async () => new WritableStream<{ type: 'write'; position: number; data: Uint8Array }>({
          write(chunk) {
            const current = files.get(name)!;
            const end = chunk.position + chunk.data.byteLength;
            const next = new Uint8Array(Math.max(current.byteLength, end));
            next.set(current);
            next.set(chunk.data, chunk.position);
            files.set(name, next);
          },
        }),
      };
    },
    async removeEntry(name: string) { files.delete(name); },
    async *entries() { for (const name of [...files.keys()]) yield [name, {}] as [string, unknown]; },
  };
  const root = { async getDirectoryHandle(name: string) { dirs.push(name); return dir; } };
  return { root, files, dirs };
}

describe('Cut export target', () => {
  it('streams to an OPFS temp file and hands back a disk-backed blob', async () => {
    const opfs = fakeOpfs();
    const sink = await createCutExportTarget({ root: opfs.root, now: 1_000 });
    expect(sink.kind).toBe('opfs');
    expect(sink.target).toBeInstanceOf(StreamTarget);
    expect(opfs.dirs).toEqual([CUT_EXPORT_DIR]);
    const [name] = [...opfs.files.keys()];
    expect(name).toMatch(/^export-1000-[a-z0-9]+\.mp4$/);
    opfs.files.set(name, new Uint8Array([0, 0, 0, 24]));
    const blob = await sink.finish();
    expect(blob.type).toBe('video/mp4');
    expect(blob.size).toBe(4);
  });

  it('deletes the half-written file on cancel and old exports on the next run', async () => {
    const now = 10 * CUT_EXPORT_STALE_MS;
    const old = `export-${now - CUT_EXPORT_STALE_MS - 1}-old.mp4`;
    const recent = `export-${now - 1000}-new.mp4`;
    const opfs = fakeOpfs([old, recent, 'notes.txt']);
    const sink = await createCutExportTarget({ root: opfs.root, now });
    expect(opfs.files.has(old)).toBe(false);
    expect(opfs.files.has(recent)).toBe(true);
    expect(opfs.files.has('notes.txt')).toBe(true);
    const current = [...opfs.files.keys()].find(name => name.startsWith(`export-${now}-`))!;
    await sink.discard();
    expect(opfs.files.has(current)).toBe(false);
    expect(opfs.files.has(recent)).toBe(true);
  });

  it('falls back to an in-memory buffer when OPFS is unavailable', async () => {
    const sink = await createCutExportTarget({ root: null });
    expect(sink.kind).toBe('memory');
    expect(sink.target).toBeInstanceOf(BufferTarget);
    await expect(sink.finish()).rejects.toThrow('no data');
    const broken = await createCutExportTarget({ root: { getDirectoryHandle: async () => { throw new Error('SecurityError'); } } });
    expect(broken.kind).toBe('memory');
  });

  it('refuses an empty export', async () => {
    const opfs = fakeOpfs();
    const sink = await createCutExportTarget({ root: opfs.root, now: 5 });
    await expect(sink.finish()).rejects.toThrow('no data');
  });
});
