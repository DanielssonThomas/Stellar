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
      text: 'Good morning. Five sample stories are on the stage. Let’s start with a smaller model that checks its own reasoning.',
      actions: [{ kind: 'overview' }],
    },
    {
      text: 'Project Juniper asks whether a small model can catch mistakes before giving you an answer.',
      actions: [{ kind: 'focus', id: 'juniper' }],
    },
    {
      text: 'Here’s the interesting part. A separate checker can flag uncertain steps. The tradeoff is how much those extra checks cost.',
      actions: [{ kind: 'expand', id: 'juniper' }],
    },
    {
      text: 'Meanwhile, Mosaic Lab tests reasoning across long documents. The benchmark asks models to reconcile sources that disagree.',
      actions: [
        { kind: 'collapse', id: 'juniper' },
        { kind: 'focus', id: 'mosaic' },
        { kind: 'expand', id: 'mosaic' },
      ],
    },
    {
      text: 'Side by side, Juniper changes how a model answers. Mosaic changes how we test the answer. Both make the evidence easier to inspect.',
      actions: [
        { kind: 'collapse', id: 'mosaic' },
        { kind: 'compare', ids: ['juniper', 'mosaic'] },
      ],
    },
    {
      text: 'Relay Systems is exploring local inference. Keeping sensitive inputs close to the application changes where teams need to measure latency.',
      actions: [
        { kind: 'focus', id: 'relay' },
        { kind: 'expand', id: 'relay' },
      ],
      after: [{ kind: 'collapse', id: 'relay' }],
    },
    {
      text: 'Meridian Studio takes on attribution. A provenance card can travel with a generated image and show how it was edited.',
      actions: [
        { kind: 'focus', id: 'meridian' },
        { kind: 'expand', id: 'meridian' },
      ],
      after: [{ kind: 'collapse', id: 'meridian' }],
    },
    {
      text: 'Finally, Harbor’s sample audit looks at the human handoff. It asks whether someone can inspect, decline, and recover from a proposed action.',
      actions: [
        { kind: 'focus', id: 'harbor' },
        { kind: 'expand', id: 'harbor' },
      ],
      after: [{ kind: 'collapse', id: 'harbor' }],
    },
    {
      text: 'That’s the briefing. I’ve left the five stories on the stage so you can explore them at your own pace.',
      actions: [{ kind: 'overview' }],
    },
  ],
};
