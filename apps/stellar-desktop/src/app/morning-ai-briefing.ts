import type { SpatialPanel, SpatialScore } from '@stellar/desktop-interaction';

const article = (
  id: string,
  category: string,
  title: string,
  summary: string,
  detail: string,
  emphasis: SpatialPanel['emphasis'] = 'supporting',
): SpatialPanel => ({
  id,
  category,
  title,
  summary,
  emphasis,
  detail: {
    surface: 'rich-text',
    payload: {
      title: 'What to watch',
      blocks: [{ kind: 'paragraph', text: detail }],
    },
  },
});

const articles = [
  article(
    'juniper',
    'Models',
    'A smaller model learns to check its work',
    'Project Juniper explores whether lightweight verification can improve reasoning on local devices.',
    'In this fictional scenario, an independent checker flags uncertain steps before the model answers. The interesting tradeoff is how often those extra checks pay for themselves in accuracy.',
    'lead',
  ),
  article(
    'mosaic',
    'Research',
    'A benchmark puts long context to work',
    'Mosaic Lab tests whether models can reconcile conflicting evidence across a long document.',
    'Several passages disagree on purpose. To score well, a model must cite the source of the disagreement and explain which evidence changed its answer.',
  ),
  article(
    'relay',
    'Infrastructure',
    'Inference moves closer to the source',
    'Relay Systems sketches a local-first deployment model for teams working with sensitive data.',
    'The design keeps raw inputs near the application. Evaluate the latency of the full workflow, including verification and handoff.',
  ),
  article(
    'meridian',
    'Industry',
    'Creative tools test clearer attribution',
    'Meridian Studio pilots provenance cards that travel with generated media.',
    'A provenance record can identify how an asset was produced and edited. A viewer can use that context when evaluating the asset.',
  ),
  article(
    'harbor',
    'Governance',
    'An audit kit follows the human handoff',
    'Harbor Initiative publishes a fictional evaluation guide for assistant approvals.',
    'The guide asks whether users can inspect a proposed action, decline it, and recover cleanly after an interruption.',
  ),
];

export const morningAiBriefing: SpatialScore = {
  begin: {
    title: 'Morning AI briefing',
    label: 'Fictional sample',
    description:
      'Five stories about reasoning, infrastructure, and trust. Presented by Ivy.',
    sample: true,
  },
  prepare: articles.map((panel) => ({ kind: 'show', panel })),
  segments: [
    {
      text: 'Good morning. Here are five sample headlines.',
      actions: [{ kind: 'overview' }],
    },
    {
      text: 'My pick for your local AI work: Juniper tests a self-checking small model.',
      actions: [{ kind: 'focus', id: 'juniper' }],
    },
    {
      text: 'A separate checker flags uncertain steps.',
      actions: [{ kind: 'expand', id: 'juniper' }],
    },
    {
      text: 'Mosaic tests whether models can reconcile conflicting sources.',
      actions: [
        { kind: 'collapse', id: 'juniper' },
        { kind: 'focus', id: 'mosaic' },
        { kind: 'expand', id: 'mosaic' },
      ],
    },
    {
      text: 'Juniper checks the answer. Mosaic tests the evidence.',
      actions: [
        { kind: 'collapse', id: 'mosaic' },
        { kind: 'compare', ids: ['juniper', 'mosaic'] },
      ],
    },
    {
      text: 'Elsewhere in AI, Relay explores running inference where the data lives.',
      actions: [
        { kind: 'focus', id: 'relay' },
        { kind: 'expand', id: 'relay' },
      ],
      after: [{ kind: 'collapse', id: 'relay' }],
    },
    {
      text: 'Meridian tests edit histories that travel with generated images.',
      actions: [
        { kind: 'focus', id: 'meridian' },
        { kind: 'expand', id: 'meridian' },
      ],
      after: [{ kind: 'collapse', id: 'meridian' }],
    },
    {
      text: 'Harbor proposes an audit for human approvals.',
      actions: [
        { kind: 'focus', id: 'harbor' },
        { kind: 'expand', id: 'harbor' },
      ],
      after: [{ kind: 'collapse', id: 'harbor' }],
    },
    {
      text: 'That’s your morning scan.',
      actions: [{ kind: 'overview' }],
    },
  ],
};
