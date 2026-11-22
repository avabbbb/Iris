// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CutTimeline } from '../components/cut/CutTimeline';
import type { CutMediaEngine } from '../services/cut/mediaEngine';
import { addClip, addSource, createCutProject, type CutSource } from '../services/cut/timeline';
import { CutPeakAccumulator, drawWaveform, sliceWaveform } from '../services/cut/waveform';

describe('Cut waveform peaks', () => {
  it('keeps the max |sample| per bin across channels while streaming blocks', () => {
    const acc = new CutPeakAccumulator(10, 1);
    // 100 Hz 采样、每格 10 个样本：第一块 0–0.5s，第二块 0.5–1s。
    const left = new Float32Array(50).fill(0.1);
    const right = new Float32Array(50).fill(-0.2);
    right[12] = -0.9;
    acc.push(0, 100, [left, right]);
    const second = new Float32Array(50).fill(0.3);
    second[49] = 1.7; // 超过 1 的样本截到 1
    acc.push(0.5, 100, [second]);
    const { peaks, peaksPerSecond, duration } = acc.result();
    expect(peaksPerSecond).toBe(10);
    expect(duration).toBeCloseTo(1);
    expect(Array.from(peaks).map(value => Math.round(value * 10) / 10)).toEqual([0.2, 0.9, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3, 0.3, 1]);
  });

  it('grows past the expected duration and resamples a window with max pooling', () => {
    const acc = new CutPeakAccumulator(10, 0);
    const data = new Float32Array(300);
    data[155] = 0.8; // 1.55s
    acc.push(0, 100, [data]);
    const waveform = acc.result();
    expect(waveform.peaks.length).toBe(30);
    // 1–2 秒压成 2 格：峰值落在第二格，不会因为跳格丢掉。
    expect(Array.from(sliceWaveform(waveform, 1, 2, 2))).toEqual([0, expect.closeTo(0.8, 5)]);
    // 超出素材部分为 0。
    expect(Array.from(sliceWaveform(waveform, 5, 6, 3))).toEqual([0, 0, 0]);
    expect(sliceWaveform(waveform, 1, 1, 4)).toHaveLength(4);
  });

  it('draws symmetric bars scaled by clip volume', () => {
    const bars: Array<[number, number, number, number]> = [];
    const ctx = { fillStyle: '', clearRect: vi.fn(), fillRect: (x: number, y: number, w: number, h: number) => { bars.push([x, y, w, h]); } };
    drawWaveform(ctx, new Float32Array([0.5, 1]), 20, 100, { volume: 0.5 });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 20, 100);
    expect(bars[0][3]).toBeCloseTo(22.5);
    expect(bars[1][3]).toBeCloseTo(45);
    expect(bars[0][1] + bars[0][3] / 2).toBeCloseTo(50);
  });
});

describe('Cut timeline waveform', () => {
  it('renders a waveform on audio clips and skips silent video clips', async () => {
    const audio: CutSource = { id: 'a1', kind: 'audio', name: 'voice.mp3', duration: 4, hasAudio: true, origin: { type: 'file', fileName: 'voice.mp3' } };
    const silent: CutSource = { id: 'v1', kind: 'video', name: 'silent.mp4', duration: 2, hasAudio: false, origin: { type: 'file', fileName: 'silent.mp4' } };
    let project = addSource(addSource(createCutProject({ fps: 30 }), audio), silent);
    project = addClip(project, { kind: 'audio', sourceId: 'a1' }).project;
    project = addClip(project, { kind: 'video', sourceId: 'v1' }).project;
    const acc = new CutPeakAccumulator(10, 4);
    acc.push(0, 100, [new Float32Array(400).fill(0.4)]);
    const waveform = vi.fn(async () => acc.result());
    const engine = {
      has: () => true,
      waveform,
      thumbnail: async () => null,
      proxyInfo: () => ({ status: 'none' }),
    } as unknown as CutMediaEngine;
    const noop = () => undefined;
    render(
      <CutTimeline
        language="zho" project={project} engine={engine} time={0} selection={[]} snapping pxPerSecond={50}
        offline={new Set()} mediaRevision={0}
        onSelect={noop} onSeek={noop} onMove={noop} onTrim={noop} onToggleMute={noop} onRemoveTrack={noop}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('cut-clip-wave')).toHaveLength(1));
    expect(waveform).toHaveBeenCalledWith('a1');
    expect(waveform).not.toHaveBeenCalledWith('v1');
    expect(screen.getByTestId('cut-clip-wave').className).not.toContain('is-strip');
  });
});
