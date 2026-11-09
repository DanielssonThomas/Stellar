import { describe, expect, it } from 'vitest';
import {
  directSpatialAction,
  initialSpatialState,
  type SpatialPanel,
  type SpatialState,
} from '@stellar/desktop-interaction';
import { spatialLayout } from './spatial-layout';

const card = (id: string): SpatialPanel => ({
  id,
  title: id,
  category: 'Research',
  summary: 'A sample',
  ...(id === 'lead' ? { emphasis: 'lead' } : {}),
});
const populated = [
  'one',
  'lead',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
].reduce(
  (state, id) =>
    directSpatialAction(state, { kind: 'show', panel: card(id) }, 'ivy'),
  initialSpatialState,
);
const compare = directSpatialAction(
  populated,
  { kind: 'compare', ids: ['lead', 'two'] },
  'ivy',
);
const focused = directSpatialAction(
  populated,
  { kind: 'focus', id: 'three' },
  'ivy',
);
const expanded = directSpatialAction(
  focused,
  { kind: 'expand', id: 'three' },
  'ivy',
);

describe('spatial composition', () => {
  it.each([360, 640, 900, 1160, 1540])(
    'fits %i pixels without intersecting slots',
    (width) => {
      for (const state of [populated, compare, focused, expanded]) {
        for (const compact of [true, false]) {
          const layout = spatialLayout(state, width, compact);
          expect(layout).toHaveLength(8);
          expect(layout).toEqual(spatialLayout(state, width, compact));
          for (const [i, a] of layout.entries()) {
            expect(a.x).toBeGreaterThanOrEqual(0);
            expect(a.x + a.width).toBeLessThanOrEqual(width);
            for (const b of layout.slice(i + 1)) {
              expect(
                a.x + a.width <= b.x ||
                  b.x + b.width <= a.x ||
                  a.y + a.height <= b.y ||
                  b.y + b.height <= a.y,
              ).toBe(true);
            }
          }
        }
      }
    },
  );

  it('puts the lead forward and lays a comparison side by side at desktop sizes', () => {
    expect(spatialLayout(populated, 1440, false)[0]).toMatchObject({
      id: 'lead',
      depth: 'foreground',
    });
    const [a, b] = spatialLayout(compare, 1440, false);
    expect(a).toMatchObject({ id: 'lead', depth: 'foreground' });
    expect(b).toMatchObject({
      id: 'two',
      depth: 'foreground',
      y: a.y,
      width: a.width,
    });
  });

  it('keeps manual focus through Ivy cues and fences updates for a user-dismissed panel', () => {
    let state: SpatialState = directSpatialAction(
      compare,
      { kind: 'focus', id: 'three' },
      'user',
    );
    state = directSpatialAction(state, { kind: 'focus', id: 'two' }, 'ivy');
    expect(state.featured).toEqual(['three']);
    state = directSpatialAction(
      state,
      { kind: 'dismiss', id: 'three' },
      'user',
    );
    state = directSpatialAction(
      state,
      { kind: 'show', panel: card('three') },
      'ivy',
    );
    expect(state.panels.some((panel) => panel.id === 'three')).toBe(false);
    expect(state.featured).toEqual([]);
    expect(
      directSpatialAction(
        state,
        { kind: 'compare', ids: ['three', 'two'] },
        'ivy',
      ),
    ).toBe(state);
  });
});
