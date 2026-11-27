import { describe, expect, it } from 'vitest';
import {
  applyCameraFragmentToPrompt,
  clampCameraRig3D,
  compileCameraPromptFragment,
  describeCameraRig3D,
  summarizeCameraControl,
} from '../components/workflow/cameraControl';
import {
  buildEvenSplitSegments,
  computeFrameDifference,
  detectSceneSegmentsFromDeltas,
} from '../services/videoSceneSplit';
import {
  createCustomTemplateFromSubgraph,
  instantiateTemplateAt,
  parseImportedWorkflowTemplate,
  relocateSeedToAnchor,
} from '../components/workflow/customTemplates';
import { WORKFLOW_TEMPLATES, buildWorkflowTemplate } from '../components/workflow/templates';
import { createWorkflowNode } from '../components/workflow/constants';

describe('TapNow Cine Camera & 3D Multi-Angle rig', () => {
  it('clamps yaw/pitch/roll/zoom into valid optical bounds', () => {
    const rig = clampCameraRig3D({ yaw: 210, pitch: 95, roll: -90, zoom: 5 });
    expect(rig.yaw).toBe(-150);
    expect(rig.pitch).toBe(80);
    expect(rig.roll).toBe(-45);
    expect(rig.zoom).toBe(2);
  });

  it('compiles camera body, cinema lens, focal length, aperture, 3D angle and movement into prompt tokens', () => {
    const fragment = compileCameraPromptFragment({
      camera: {
        camera: 'ARRI ALEXA 35',
        lens: 'Cooke Anamorphic/i SF',
        focalLength: '50mm',
        aperture: 'f/1.4',
      },
      cameraMovement: 'camera push in',
      rig3d: { yaw: -38, pitch: -30, roll: 12, zoom: 0.6 },
    });
    expect(fragment).toContain('shot on ARRI ALEXA 35');
    expect(fragment).toContain('Cooke Anamorphic/i SF lens');
    expect(fragment).toContain('50mm focal length');
    expect(fragment).toContain('shallow depth of field');
    expect(fragment).toContain('camera push in');
    expect(fragment).toContain('Dutch tilt');
  });

  it('merges camera fragment idempotently without duplicating tags', () => {
    const first = applyCameraFragmentToPrompt('Rainy neon alley', 'shot on Sony Venice 2 8K');
    expect(first).toBe('Rainy neon alley [Camera: shot on Sony Venice 2 8K]');
    const second = applyCameraFragmentToPrompt(first, 'shot on ARRI ALEXA 65 large format');
    expect(second).toBe('Rainy neon alley [Camera: shot on ARRI ALEXA 65 large format]');
    const cleared = applyCameraFragmentToPrompt(second, '');
    expect(cleared).toBe('Rainy neon alley');
  });

  it('produces concise UI badge summaries and localized descriptions', () => {
    const summary = summarizeCameraControl({
      camera: { camera: 'ARRI ALEXA 35', focalLength: '85mm', aperture: 'f/1.4' },
      rig3d: { yaw: 45, pitch: -20, roll: 0, zoom: 1 },
    }, 'zho');
    expect(summary).toContain('ARRI ALEXA 35');
    expect(summary).toContain('85mm');
    expect(summary).toContain('3D视角 45°/-20°');
    expect(describeCameraRig3D({ yaw: 0, pitch: 78, roll: 0, zoom: 1.35, presetId: 'top-down' }, 'zho')).toBe('顶视鸟瞰');
  });
});

describe('TapNow Video Smart Split (local scene-cut detection)', () => {
  it('computes normalized luminance difference between RGBA buffers', () => {
    const black = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const white = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(computeFrameDifference(black, black)).toBe(0);
    expect(computeFrameDifference(black, white)).toBeCloseTo(1, 3);
  });

  it('detects scene cuts with non-maximum suppression and builds contiguous segments', () => {
    const deltas = [
      { timeSec: 1.0, delta: 0.05 },
      { timeSec: 3.0, delta: 0.52 },
      { timeSec: 3.3, delta: 0.44 }, // suppressed because < minSegmentSec from 3.0
      { timeSec: 6.5, delta: 0.61 },
      { timeSec: 9.0, delta: 0.08 },
    ];
    const segments = detectSceneSegmentsFromDeltas(deltas, 10, { threshold: 0.28, minSegmentSec: 1.0 });
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ index: 1, startSec: 0, endSec: 3 });
    expect(segments[1]).toMatchObject({ index: 2, startSec: 3, endSec: 6.5 });
    expect(segments[2]).toMatchObject({ index: 3, startSec: 6.5, endSec: 10 });
  });

  it('builds even-split fallback segments cleanly', () => {
    const even = buildEvenSplitSegments(9, 3);
    expect(even).toHaveLength(3);
    expect(even[0].startSec).toBe(0);
    expect(even[2].endSec).toBe(9);
  });
});

describe('Tapflow Custom Workflow Templates & Expanded Blueprints', () => {
  it('ships 10 production blueprints that relocate cleanly to any canvas anchor', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    const seed = buildWorkflowTemplate('multi-angle-studio', '', 'zho');
    const placed = relocateSeedToAnchor(seed, { x: 500, y: 300 });
    expect(placed.nodes).toHaveLength(seed.nodes.length);
    expect(placed.connections).toHaveLength(seed.connections.length);
    expect(Math.min(...placed.nodes.map(n => n.position.x))).toBe(500);
    expect(Math.min(...placed.nodes.map(n => n.position.y))).toBe(300);
    // Fresh IDs must not collide with original seed
    const seedIds = new Set(seed.nodes.map(n => n.id));
    expect(placed.nodes.some(n => seedIds.has(n.id))).toBe(false);
  });

  it('captures a subgraph into a clean template, strips runtime status, and instantiates with fresh IDs', () => {
    const n1 = { ...createWorkflowNode('orig-1', 'image', { x: 100, y: 200 }, { prompt: 'Hero', status: 'success', storageKey: 'secret-blob', colorTag: 'mint' }), title: 'Hero' };
    const n2 = { ...createWorkflowNode('orig-2', 'video', { x: 520, y: 240 }, { prompt: 'Orbit', status: 'error', error: 'boom' }), title: 'Orbit' };
    const tpl = createCustomTemplateFromSubgraph({
      name: 'My Cinema Flow',
      nodes: [n1, n2],
      connections: [{ id: 'e1', fromNodeId: 'orig-1', toNodeId: 'orig-2', kind: 'data' }],
    });
    expect(tpl.nodes).toHaveLength(2);
    expect(tpl.connections).toHaveLength(1);
    expect(tpl.nodes[0].offsetX).toBe(0);
    expect(tpl.nodes[1].offsetX).toBe(420);
    expect((tpl.nodes[0].metadata as Record<string, unknown>).storageKey).toBeUndefined();

    const parsed = parseImportedWorkflowTemplate(JSON.parse(JSON.stringify(tpl)));
    const materialized = instantiateTemplateAt(parsed, { x: 1000, y: 500 });
    expect(materialized.nodes).toHaveLength(2);
    expect(materialized.nodes[0].position).toEqual({ x: 1000, y: 500 });
    expect(materialized.nodes[1].position).toEqual({ x: 1420, y: 540 });
    expect(materialized.nodes[0].metadata.status).toBe('idle');
    expect(materialized.connections[0].fromNodeId).toBe(materialized.nodes[0].id);
    expect(materialized.connections[0].toNodeId).toBe(materialized.nodes[1].id);
  });
});
