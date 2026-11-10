import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { decodeSpatialScore } from './spatial-score';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { boundedJson } from './stage-json';

const chart = {
  type: 'line',
  labels: ['Morning', 'Afternoon'],
  datasets: [{ label: 'Volume', values: [2, 4] }],
};

function show(surface: string, payload: unknown) {
  return {
    kind: 'show',
    panel: {
      id: 'evidence',
      title: 'Evidence',
      category: 'Research',
      summary: 'A short summary.',
      detail: { surface, payload },
    },
  };
}

describe(decodeSpatialScore.name, () => {
  it('admits a standalone chart in the preparation actions', () => {
    const payload = { title: 'Volume', chart };
    const score = decodeSpatialScore(
      { prepare: [show('chart', payload)] },
      TestBed.inject(STAGE_CATALOGUE),
    );
    expect(score?.prepare?.[0]).toMatchObject({
      panel: { detail: { payload } },
    });
  });

  it('admits nested rich-text blocks in a narrated show action', () => {
    const payload = {
      title: 'Evidence',
      blocks: [
        { kind: 'paragraph', text: 'Here is what changed.' },
        { kind: 'list', items: ['First', 'Second'] },
        { kind: 'table', columns: ['Name', 'Count'], rows: [['Result', '2']] },
        { kind: 'chart', chart },
      ],
    };
    const score = decodeSpatialScore(
      {
        segments: [
          {
            text: 'Here is the evidence.',
            actions: [show('rich-text', payload)],
          },
        ],
      },
      TestBed.inject(STAGE_CATALOGUE),
    );
    expect(score?.segments?.[0].actions[0]).toMatchObject({
      panel: { detail: { payload } },
    });
  });

  it('keeps the general depth bound and rejects overly deep spatial input', () => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 16; depth++) value = [value];
    expect(boundedJson(value, 1024)).toBe(false);
    expect(boundedJson(value, 1024, 0, 15)).toBe(false);
    expect(
      decodeSpatialScore(
        { prepare: [show('rich-text', value)] },
        TestBed.inject(STAGE_CATALOGUE),
      ),
    ).toBeNull();
  });
});
