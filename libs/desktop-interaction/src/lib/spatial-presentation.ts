export interface SpatialScene {
  readonly title: string;
  readonly label: string;
  readonly description?: string;
  readonly sample?: boolean;
}

export interface SpatialPanel {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly summary: string;
  readonly group?: string;
  readonly emphasis?: 'lead' | 'supporting';
  readonly source?: string;
  readonly thumbnail?: { readonly src: string; readonly alt: string };
  readonly detail?: { readonly surface: string; readonly payload: unknown };
}

export type SpatialAction =
  | { readonly kind: 'show'; readonly panel: SpatialPanel }
  | {
      readonly kind: 'focus' | 'defocus' | 'expand' | 'collapse' | 'dismiss';
      readonly id: string;
    }
  | { readonly kind: 'compare'; readonly ids: readonly [string, string] }
  | { readonly kind: 'overview' | 'clear' };

export interface SpatialSegment {
  readonly text: string;
  readonly actions: readonly SpatialAction[];
  readonly after?: readonly SpatialAction[];
}

export interface SpatialScore {
  readonly begin?: SpatialScene;
  readonly prepare?: readonly SpatialAction[];
  readonly segments?: readonly SpatialSegment[];
}

export const spatialPanelLimit = 8;

export interface SpatialState {
  readonly panels: readonly SpatialPanel[];
  readonly featured: readonly string[];
  readonly expanded: readonly string[];
  readonly manual: boolean;
  readonly dismissed: readonly string[];
}

export const initialSpatialState: SpatialState = {
  panels: [],
  featured: [],
  expanded: [],
  manual: false,
  dismissed: [],
};

export function directSpatialAction(
  state: SpatialState,
  action: SpatialAction,
  origin: 'ivy' | 'user',
): SpatialState {
  if (action.kind === 'clear') return initialSpatialState;
  if (action.kind === 'show') {
    const index = state.panels.findIndex(
      (panel) => panel.id === action.panel.id,
    );
    if (
      state.dismissed.includes(action.panel.id) ||
      (index < 0 && state.panels.length >= spatialPanelLimit)
    )
      return state;
    return {
      ...state,
      panels:
        index < 0
          ? [...state.panels, action.panel]
          : state.panels.map((panel, i) =>
              i === index ? action.panel : panel,
            ),
    };
  }
  const exists = (id: string) => state.panels.some((panel) => panel.id === id);
  if ('id' in action && !exists(action.id)) return state;
  if (action.kind === 'dismiss') {
    return {
      ...state,
      panels: state.panels.filter((panel) => panel.id !== action.id),
      featured: state.featured.filter((id) => id !== action.id),
      expanded: state.expanded.filter((id) => id !== action.id),
      dismissed:
        origin === 'user' ? [...state.dismissed, action.id] : state.dismissed,
    };
  }
  if (origin === 'ivy' && state.manual) return state;
  const manual = origin === 'user' || state.manual;
  switch (action.kind) {
    case 'focus':
      return { ...state, manual, featured: [action.id] };
    case 'defocus':
      return {
        ...state,
        manual,
        featured: state.featured.filter((id) => id !== action.id),
      };
    case 'expand':
      return {
        ...state,
        manual,
        featured:
          state.featured.length && !state.featured.includes(action.id)
            ? [action.id]
            : state.featured,
        expanded: state.expanded.includes(action.id)
          ? state.expanded
          : [...state.expanded, action.id],
      };
    case 'collapse':
      return {
        ...state,
        manual,
        expanded: state.expanded.filter((id) => id !== action.id),
      };
    case 'compare':
      return action.ids[0] !== action.ids[1] && action.ids.every(exists)
        ? { ...state, manual, featured: action.ids }
        : state;
    case 'overview':
      return { ...state, manual, featured: [] };
  }
}
