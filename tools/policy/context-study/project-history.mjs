import { readFile, writeFile } from 'node:fs/promises';

const [metricsPath, outputPath] = process.argv.slice(2);
if (!metricsPath || !outputPath)
  throw new Error('Usage: project-history <token-metrics.json> <output.json>');

const metrics = JSON.parse(await readFile(metricsPath, 'utf8'));
const historical = {
  attempt06Request1PromptTokens: 13_815,
  attempt06Request2PromptTokens: 18_428,
  attempt06Request2RemainingBudget: 17_998,
  attempt06Request2ToolResultMessages: 5,
  attempt06Request2ToolRoleTokens: 4_395,
  attempt06Request1SystemRoleTokens: 4_803,
  attempt06Request1ToolSchemaTokens: 7_817,
};
const tokenBudget = 32_000;
const planningTarget = 28_000;
const completionReserves = [100, 200, 500, 1_000, 1_500];
const historicalPrefillTokensPerSecond = 73.38;
const historicalGenerationTokensPerSecond = 4.92;
const slowSensitivityFactor = 0.8;
const attempt06ResidualSeconds =
  258.795 -
  13_815 / historicalPrefillTokensPerSecond -
  187 / historicalGenerationTokensPerSecond;

const runtime = {};
for (const [scenario, promptTokens] of Object.entries(
  metrics.promptScenarios,
)) {
  const requestCount = promptTokens.length;
  const promptTotal = promptTokens.reduce((sum, count) => sum + count, 0);
  runtime[scenario] = {
    requestCount,
    promptTokens,
    promptGrowth: promptTokens.map((count, index) =>
      index === 0 ? 0 : count - promptTokens[index - 1],
    ),
    promptTotal,
    completionScenarios: {},
  };
  for (const completionReserve of completionReserves) {
    const totalCompletionTokens = requestCount * completionReserve;
    const cumulativeTokens = promptTotal + totalCompletionTokens;
    const nominalComputeSeconds =
      promptTotal / historicalPrefillTokensPerSecond +
      totalCompletionTokens / historicalGenerationTokensPerSecond;
    const slowComputeSeconds =
      promptTotal / (historicalPrefillTokensPerSecond * slowSensitivityFactor) +
      totalCompletionTokens /
        (historicalGenerationTokensPerSecond * slowSensitivityFactor);
    const overheadRangeSeconds = [
      attempt06ResidualSeconds,
      requestCount * attempt06ResidualSeconds,
    ];
    runtime[scenario].completionScenarios[completionReserve] = {
      totalCompletionTokens,
      cumulativeTokens,
      remainingUnder32k: tokenBudget - cumulativeTokens,
      remainingUnder28k: planningTarget - cumulativeTokens,
      nominalComputeSeconds,
      slowSensitivityComputeSeconds: slowComputeSeconds,
      operationalOverheadRangeSeconds: overheadRangeSeconds,
      runtimeRangeSeconds: [
        nominalComputeSeconds + overheadRangeSeconds[0],
        slowComputeSeconds + overheadRangeSeconds[1],
      ].map((value) => Math.round(value * 100) / 100),
    };
  }
}

const result = {
  historical,
  assumptions: {
    syntheticFixedSystemTokens: metrics.syntheticFixedSystemTokens,
    fullPromptCountsUseApplyTemplateAndTokenize: true,
    historicalPromptBodiesReconstructed: false,
    historicalThirdPromptProjected: false,
    completionReserves,
    historicalRates: {
      prefillTokensPerSecond: historicalPrefillTokensPerSecond,
      generationTokensPerSecond: historicalGenerationTokensPerSecond,
    },
    slowSensitivityFactor,
    attempt06ResidualSeconds,
    operationalOverheadMethod:
      'One observed attempt-06 non-prefill/non-generation residual is the lower endpoint; repeating that residual once per model request is the upper endpoint. Its contents are not separately measured and this is a sensitivity range, not a guarantee.',
  },
  scenarios: runtime,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
