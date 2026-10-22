import { readFile, writeFile } from 'node:fs/promises';
import { projectRequests } from './context-study.mjs';

const [metricsPath, outputPath] = process.argv.slice(2);
if (!metricsPath || !outputPath)
  throw new Error('Usage: project-history <token-metrics.json> <output.json>');

const metrics = JSON.parse(await readFile(metricsPath, 'utf8'));
const prompt = metrics.promptScenarios;
const observedPrompts = [13_815, 18_428];
const projectedPrompts = [
  ...observedPrompts,
  observedPrompts[1] + (observedPrompts[1] - observedPrompts[0]),
];
const schemaSavings = prompt.currentFocus.map(
  (value, index) => value - prompt.narrowProfile[index],
);
const resultSavings = prompt.narrowProfile.map(
  (value, index) => value - prompt.narrowProfileCompacted[index],
);
const checkpointSavings = prompt.currentFocus.map(
  (value, index) => value - prompt.checkpointedFocus[index],
);

const scenarios = {};
for (const [name, options] of Object.entries({
  currentFocus: {},
  narrowProfile: { schemaSavings },
  narrowProfilePlusCompaction: { schemaSavings, resultSavings },
  checkpointedFocus: { checkpointSavings },
})) {
  scenarios[name] = {};
  for (const transferFactor of [0.5, 1]) {
    const transferKey =
      transferFactor === 0.5 ? 'halfTransfer' : 'fullTransfer';
    scenarios[name][transferKey] = {};
    for (const completionReserve of [1_000, 1_500]) {
      const requests = projectRequests({
        baselinePrompts: projectedPrompts,
        ...options,
        transferFactor,
        completionReserve,
      });
      const promptTotal = requests.reduce(
        (sum, request) => sum + request.promptTokens,
        0,
      );
      const total = requests.at(-1).cumulativeTokens;
      scenarios[name][transferKey][completionReserve] = {
        requests,
        promptTotal,
        cumulativeTokens: total,
        remainingUnder32k: 32_000 - total,
        remainingUnder28kTarget: 28_000 - total,
        extraPromptReductionFor32k: Math.max(0, total - 32_000),
        extraPromptReductionFor28k: Math.max(0, total - 28_000),
        averageCompletionHeadroomUnder32k: Math.floor(
          (32_000 - promptTotal) / 3,
        ),
        averageCompletionHeadroomUnder28k: Math.floor(
          (28_000 - promptTotal) / 3,
        ),
      };
    }
  }
}

const prefillTokensPerSecond = 73.38;
const generationTokensPerSecond = 4.92;
const attempt06RuntimeSeconds = 258.795;
const attempt06FirstPromptPrefillSeconds = 13_815 / prefillTokensPerSecond;
const attempt06FirstCompletionSeconds = 187 / generationTokensPerSecond;
const observedResidualSeconds =
  attempt06RuntimeSeconds -
  attempt06FirstPromptPrefillSeconds -
  attempt06FirstCompletionSeconds;
const operationalOverheadRangeSeconds = [65, 120];
const runtime = {};
for (const [name, transferFactor] of [
  ['halfTransfer', 0.5],
  ['fullTransfer', 1],
]) {
  const requests = projectRequests({
    baselinePrompts: projectedPrompts,
    schemaSavings,
    resultSavings,
    transferFactor,
    completionReserve: 0,
  });
  const promptTotal = requests.reduce(
    (sum, request) => sum + request.promptTokens,
    0,
  );
  runtime[name] = {
    promptTotal,
    prefillSeconds: promptTotal / prefillTokensPerSecond,
    completionScenarios: {},
  };
  for (const completionTokensPerRequest of [100, 200, 300, 500, 1_000, 1_500]) {
    const generationSeconds =
      (3 * completionTokensPerRequest) / generationTokensPerSecond;
    runtime[name].completionScenarios[completionTokensPerRequest] = {
      totalCompletionTokens: 3 * completionTokensPerRequest,
      generationSeconds,
      totalSecondsByOperationalOverhead: operationalOverheadRangeSeconds.map(
        (overhead) =>
          Math.round(
            (runtime[name].prefillSeconds + generationSeconds + overhead) * 100,
          ) / 100,
      ),
    };
  }
}

const result = {
  measuredHistoricalAnchors: observedPrompts,
  projectedThirdPrompt: projectedPrompts[2],
  projectedTurnGrowth: [
    projectedPrompts[1] - projectedPrompts[0],
    projectedPrompts[2] - projectedPrompts[1],
  ],
  syntheticSavings: { schemaSavings, resultSavings, checkpointSavings },
  transferFactors: {
    half: 0.5,
    full: 1,
    note: 'The half-transfer case is a planning haircut, not a measured confidence interval.',
  },
  completionReserveScenarios: scenarios,
  runtime: {
    prefillTokensPerSecond,
    generationTokensPerSecond,
    attempt06RuntimeSeconds,
    attempt06FirstPromptPrefillSeconds,
    attempt06FirstCompletionSeconds,
    residualForStartupToolsAndOtherWorkSeconds: observedResidualSeconds,
    operationalOverheadRangeSeconds,
    runtimeScenarios: runtime,
  },
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
