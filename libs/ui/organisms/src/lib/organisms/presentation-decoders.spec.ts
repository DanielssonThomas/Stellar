import { describe, expect, it, vi } from 'vitest';
import {
  decodePresentationText,
  decodePresentationImage,
  decodePresentationBrowser,
  decodePresentationDiagram,
  decodePresentationWorkflow,
  decodePresentationSession,
} from './presentation-decoders';
import { createStageRegistry } from './stage-registry';

describe('trusted presentation payloads', () => {
  it('validates all structured text block types and rejects executable or inconsistent payloads', () => {
    const value = {
      title: 'Requirements',
      blocks: [
        { kind: 'heading', text: 'Scope' },
        { kind: 'paragraph', text: 'Preserve C:\\repo\\file.ts and ALPHA-42.' },
        { kind: 'code', text: '<img src=x>', language: 'HTML' },
        { kind: 'list', items: ['One', 'Two'] },
        { kind: 'checklist', items: [{ text: 'Verified', checked: false }] },
        {
          kind: 'table',
          columns: ['Item', 'Result'],
          rows: [['A', 'Pending']],
        },
      ],
    };
    expect(decodePresentationText(value)).toEqual(value);
    expect(decodePresentationText({ ...value, html: '<script />' })).toBeNull();
    expect(
      decodePresentationText({
        title: 'Wrong width',
        blocks: [{ kind: 'table', columns: ['One'], rows: [['Two', 'Cells']] }],
      }),
    ).toBeNull();
    expect(
      decodePresentationText({
        title: 'Invalid',
        blocks: [{ kind: 'paragraph', text: '\u0000' }],
      }),
    ).toBeNull();
    expect(
      decodePresentationText({
        title: 'Invalid',
        blocks: [{ kind: 'code', text: '\ud800' }],
      }),
    ).toBeNull();
    expect(
      decodePresentationText({
        title: 'Invalid',
        blocks: [{ kind: 'iframe', src: 'https://example.com' }],
      }),
    ).toBeNull();
  });
  it('rejects sparse and custom-prototype block arrays without executing inherited code', () => {
    const execute = vi.fn();
    const blocks = Object.setPrototypeOf(
      [{ kind: 'paragraph', text: 'Safe' }],
      { map: execute },
    );
    expect(decodePresentationText({ title: 'Invalid', blocks })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(
      decodePresentationText({ title: 'Invalid', blocks: new Array(2) }),
    ).toBeNull();
  });
  it('confines images to bounded local raster sources and browser addresses to inert HTTP text', () => {
    const image = {
      title: 'Reference',
      alt: 'Reference image',
      src: '/emblem/layers/gold-hair.png',
    };
    expect(decodePresentationImage(image)).toMatchObject({
      ...image,
      kind: 'image',
    });
    expect(decodePresentationImage({ ...image, kind: 'image' })).not.toBeNull();
    for (const src of [
      'https://example.com/tracker.png',
      '/emblem/layers/../../secret.png',
      'file:///private.png',
      'data:image/svg+xml;base64,AAAA',
      'javascript:alert(1)',
    ])
      expect(decodePresentationImage({ ...image, src })).toBeNull();
    expect(
      decodePresentationImage({ ...image, src: 'data:image/png;base64,AAAA' }),
    ).not.toBeNull();
    expect(
      decodePresentationImage({
        ...image,
        src: 'data:image/png;base64,' + 'A'.repeat(512 * 1024),
      }),
    ).toBeNull();
    expect(
      decodePresentationBrowser({ title: 'Docs', url: 'https://example.com' }),
    ).toMatchObject({ kind: 'browser', url: 'https://example.com/' });
    for (const url of [
      'javascript:alert(1)',
      'file:///private',
      'https://name:secret@example.com',
      'data:text/html,foo',
    ])
      expect(decodePresentationBrowser({ title: 'Invalid', url })).toBeNull();
  });
  it('rejects duplicate nodes, missing edge targets and untrusted diagram syntax', () => {
    const diagram = {
      title: 'Flow',
      nodes: [
        { id: 'a', label: 'Prepare' },
        { id: 'b', label: 'Verify' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    expect(decodePresentationDiagram(diagram)).toEqual(diagram);
    expect(
      decodePresentationDiagram({
        ...diagram,
        nodes: [diagram.nodes[0], diagram.nodes[0]],
      }),
    ).toBeNull();
    expect(
      decodePresentationDiagram({
        ...diagram,
        edges: [{ from: 'a', to: 'missing' }],
      }),
    ).toBeNull();
    expect(
      decodePresentationDiagram({ ...diagram, script: 'fetch()' }),
    ).toBeNull();
    expect(
      decodePresentationDiagram({
        ...diagram,
        edges: [{ from: 'a', to: 'a' }],
      }),
    ).toBeNull();
  });
  it('accepts source selectors and rejects model-supplied telemetry values', () => {
    expect(
      decodePresentationWorkflow({ title: 'Workflow', project: 'stellar' }),
    ).toEqual({ kind: 'workflow', title: 'Workflow', project: 'stellar' });
    expect(decodePresentationSession({ title: 'Session' })).toEqual({
      kind: 'session',
      title: 'Session',
    });
    expect(
      decodePresentationWorkflow({
        title: 'Fake',
        state: 'running',
        model: 'sol',
      }),
    ).toBeNull();
    expect(
      decodePresentationSession({ title: 'Fake', context: 80 }),
    ).toBeNull();
    expect(
      decodePresentationSession({ title: 'Fake', project: 'stellar' }),
    ).toBeNull();
  });
  it('admits useful long structured content while keeping immutable registry snapshots', () => {
    const registry = createStageRegistry({
      'rich-text': decodePresentationText,
    });
    const payload = {
      title: 'Long content',
      blocks: [{ kind: 'paragraph', text: 'Requirement\n'.repeat(1200) }],
    };
    expect(
      registry.dispatch({
        contractVersion: 1,
        commandId: 1,
        instanceId: 'long',
        action: 'open',
        surface: 'rich-text',
        prominence: 'primary',
        payload,
      }).status,
    ).toBe('applied');
    payload.blocks[0].text = 'Changed outside';
    expect(JSON.stringify(registry.inspect())).not.toContain('Changed outside');
    expect(Object.isFrozen(registry.inspect()[0].payload)).toBe(true);
  });
});
