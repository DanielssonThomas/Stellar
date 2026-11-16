import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { STAGE_CATALOGUE } from './stage-catalogue';
import { decodePresentationText } from './presentation-decoders';
import { decodeSpatialScore } from './spatial-score';
const payload = {
  title: 'Report',
  blocks: [
    {
      kind: 'statistics',
      statistics: {
        title: 'Fixture',
        source: 'Deterministic fixture',
        period: 'Fixture A',
        state: 'ready',
        coverage: 'complete',
        freshness: 'current',
        metrics: [{ name: 'Count', value: 0, unit: 'items' }],
      },
    },
  ],
};
describe('statistics workspace and spatial decoding', () => {
  it('accepts the same rich-text composition in both routes and rejects malformed content', () => {
    const catalogue = TestBed.inject(STAGE_CATALOGUE);
    expect(catalogue['rich-text'].decode(payload)).toEqual(payload);
    expect(
      decodePresentationText({
        ...payload,
        blocks: [
          {
            kind: 'statistics',
            statistics: { ...payload.blocks[0].statistics, source: '' },
          },
        ],
      }),
    ).toBeNull();
    expect(
      decodeSpatialScore(
        {
          prepare: [
            {
              kind: 'show',
              panel: {
                id: 'stats',
                category: 'Statistics',
                title: 'Stats',
                summary: 'Fixture only',
                detail: { surface: 'rich-text', payload },
              },
            },
          ],
          segments: [],
        },
        catalogue,
      ),
    ).not.toBeNull();
  });
});
