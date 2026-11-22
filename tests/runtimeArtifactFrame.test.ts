// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeRuntimeArtifactFrame } from '../services/runtimeArtifacts';

function frame(mime: string, body: Uint8Array): ArrayBuffer {
  const mimeBytes = new TextEncoder().encode(mime);
  const out = new Uint8Array(4 + mimeBytes.length + body.length);
  new DataView(out.buffer).setUint32(0, mimeBytes.length, false);
  out.set(mimeBytes, 4);
  out.set(body, 4 + mimeBytes.length);
  return out.buffer;
}

describe('runtime artifact binary frame', () => {
  it('splits the mime header from the file bytes', async () => {
    const body = new Uint8Array([0, 1, 2, 250, 255]);
    const blob = decodeRuntimeArtifactFrame(frame('video/mp4', body));
    expect(blob.type).toBe('video/mp4');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(body);
  });

  it('falls back to the caller mime type when the runtime has none', () => {
    expect(decodeRuntimeArtifactFrame(frame('', new Uint8Array([1])), 'image/png').type).toBe('image/png');
    expect(decodeRuntimeArtifactFrame(frame('', new Uint8Array([1]))).type).toBe('application/octet-stream');
  });

  it('rejects truncated frames', () => {
    expect(() => decodeRuntimeArtifactFrame(new ArrayBuffer(2))).toThrow('不完整');
    const broken = new Uint8Array(6);
    new DataView(broken.buffer).setUint32(0, 99, false);
    expect(() => decodeRuntimeArtifactFrame(broken.buffer)).toThrow('不完整');
  });
});
