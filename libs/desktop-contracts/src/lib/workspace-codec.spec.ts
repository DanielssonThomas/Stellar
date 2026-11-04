import { describe, expect, it } from 'vitest';
import {
  decodeWorkspaceToolOutcome,
  decodeWorkspaceToolRequest,
} from './workspace-codec';

const envelope = {
  version: 1,
  request_id: '1234567890abcdef1234567890abcdef',
  epoch: '2',
  turn_id: '00000000-0000-4000-8000-000000000001',
  expires_at_ms: '1700000015000',
  operation: {
    kind: 'open',
    instance_id: 'pane',
    surface: 'rich-text',
    payload_json: '{"body":"hello"}',
    prominence: 'primary',
  },
};

describe('workspace tool contract', () => {
  it('validates render observations without promoting loading/error to ready', () => {
    const request = decodeWorkspaceToolRequest({
      ...envelope,
      operation: { kind: 'inspect' },
    });
    for (const render_state of [
      'ready',
      'loading',
      'error',
      'hidden',
      'unavailable',
    ]) {
      const outcome = {
        kind: 'inspection',
        panes: [
          {
            instance_id: 'image',
            surface: 'image',
            prominence: 'primary',
            minimized: false,
            render_state,
          },
        ],
      };
      expect(decodeWorkspaceToolOutcome(outcome, request)).toEqual(outcome);
    }
    for (const render_state of ['success', 1, {}, 'loaded'])
      expect(() =>
        decodeWorkspaceToolOutcome(
          {
            kind: 'inspection',
            panes: [
              {
                instance_id: 'image',
                surface: 'image',
                prominence: 'primary',
                minimized: false,
                render_state,
              },
            ],
          },
          request,
        ),
      ).toThrow();
  });
  it('validates native monitor targets without permitting renderer capture replies', () => {
    for (const operation of [
      { kind: 'list_displays' },
      { kind: 'capture_foreground' },
      { kind: 'capture_display', display_id: null },
      { kind: 'capture_display', display_id: '\\\\.\\DISPLAY1' },
    ]) {
      const request = decodeWorkspaceToolRequest({ ...envelope, operation });
      expect(request.operation).toEqual(operation);
      expect(() =>
        decodeWorkspaceToolOutcome({ kind: 'applied' }, request),
      ).toThrow();
    }
    for (const display_id of ['', 'x'.repeat(129), '\0bad', 1])
      expect(() =>
        decodeWorkspaceToolRequest({
          ...envelope,
          operation: { kind: 'capture_display', display_id },
        }),
      ).toThrow();
  });
  it('rejects extra authority, invalid surfaces and over-budget content', () => {
    expect(decodeWorkspaceToolRequest(envelope)).toEqual(envelope);
    for (const value of [
      { ...envelope, command_id: 9 },
      { ...envelope, epoch: '02' },
      { ...envelope, expires_at_ms: '18446744073709551615' },
      {
        ...envelope,
        operation: { ...envelope.operation, surface: 'activity-summary' },
      },
      { ...envelope, operation: { ...envelope.operation, surface: 'html' } },
      {
        ...envelope,
        operation: { ...envelope.operation, instance_id: '../path' },
      },
      { ...envelope, operation: { ...envelope.operation, payload_json: '[]' } },
      {
        ...envelope,
        operation: {
          ...envelope.operation,
          surface: 'browser',
          payload_json: JSON.stringify({ body: 'x'.repeat(4096) }),
        },
      },
    ])
      expect(() => decodeWorkspaceToolRequest(value)).toThrow();
  });

  it('accepts only the actual operation-compatible outcome and safe inspection fields', () => {
    const inspect = decodeWorkspaceToolRequest({
      ...envelope,
      operation: { kind: 'inspect' },
    });
    const result = {
      kind: 'inspection',
      panes: [
        {
          instance_id: 'pane',
          surface: 'activity-summary',
          prominence: 'primary',
          minimized: false,
        },
      ],
    };
    expect(decodeWorkspaceToolOutcome(result, inspect)).toEqual(result);
    expect(() =>
      decodeWorkspaceToolOutcome(
        { ...result, panes: [{ ...result.panes[0], payload: 'secret' }] },
        inspect,
      ),
    ).toThrow();
    expect(() =>
      decodeWorkspaceToolOutcome({ kind: 'applied' }, inspect),
    ).toThrow();
    expect(() =>
      decodeWorkspaceToolOutcome(result, decodeWorkspaceToolRequest(envelope)),
    ).toThrow();
  });
});
