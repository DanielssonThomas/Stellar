import { readFile, writeFile } from 'node:fs/promises';
import { compactToolResult, retrieveCompactedRange } from './context-study.mjs';
import { syntheticToolResults } from './synthetic-fixtures.mjs';
import { TrustedArtifactStore } from './trusted-artifact-store.mjs';

const [schemaPath, corpusPath] = process.argv.slice(2);
if (!schemaPath || !corpusPath)
  throw new Error('Usage: build-synthetic-corpus <schema-json> <corpus-json>');

const schemaOutput = JSON.parse(await readFile(schemaPath, 'utf8'));
const currentTools = schemaOutput.schemas.currentVisible;
const narrowTools = schemaOutput.schemas.narrowProfile;
let nextArtifactId = 0;
const artifactStore = new TrustedArtifactStore({
  createId: () => (++nextArtifactId).toString(16).padStart(32, '0'),
});
const compactedResults = syntheticToolResults.map((result) =>
  compactToolResult({
    ...result,
    artifactStore,
    scope: 'synthetic-attempt-80',
  }),
);
const artifactRetrievalTool = {
  type: 'function',
  function: {
    name: 'retrieve_output_artifact',
    description:
      'Retrieve an exact line range from this attempt’s retained tool output. Scope is bound by the trusted caller; paths, filesystem access, and other attempts are not addressable.',
    parameters: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', pattern: '^[a-f0-9]{32}$' },
        first_line: { type: 'integer', minimum: 1 },
        last_line: { type: 'integer', minimum: 1 },
      },
      required: ['artifact_id', 'first_line', 'last_line'],
      additionalProperties: false,
    },
  },
};
const baselineMessages = [
  {
    role: 'system',
    content: '__SYNTHETIC_FIXED_SYSTEM__',
  },
  {
    role: 'user',
    content:
      'Synthetic task: add a shape variant to a shared loading component; inspect, edit, test, and report.',
  },
];

function toolBatch(results, offset) {
  const functionNames = ['terminal', 'search_files', 'read_file', 'terminal'];
  const calls = results.map((result, index) => ({
    id: `synthetic-call-${offset + index + 1}`,
    type: 'function',
    function: {
      name: functionNames[index % functionNames.length],
      arguments: JSON.stringify({ query: `synthetic-${offset + index + 1}` }),
    },
  }));
  const assistant = {
    role: 'assistant',
    content:
      'Synthetic completion: I inspected the relevant component convention and will follow the bounded task plan.',
    tool_calls: calls,
  };
  const outputs = results.map((result, index) => ({
    role: 'tool',
    tool_call_id: calls[index].id,
    name: calls[index].function.name,
    content: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\nexit=${result.exitCode}`,
  }));
  return [assistant, ...outputs];
}

function retrievalBatch(omission) {
  const callId = 'synthetic-retrieval-call-01';
  const retrieved = retrieveCompactedRange(
    artifactStore,
    'synthetic-attempt-80',
    omission,
  );
  return [
    {
      role: 'assistant',
      content:
        'Synthetic completion: retrieve the exact omitted repeated span for review.',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: 'retrieve_output_artifact',
            arguments: JSON.stringify({
              artifact_id: omission.artifactId,
              first_line: omission.firstLine,
              last_line: omission.lastLine,
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      name: 'retrieve_output_artifact',
      content: retrieved.content,
    },
  ];
}

const firstResults = syntheticToolResults.slice(0, 5);
const secondResults = syntheticToolResults.slice(5);
const compactFirst = compactedResults.slice(0, 5);
const compactSecond = compactedResults.slice(5);

const firstBatch = toolBatch(firstResults, 0);
const secondBatch = toolBatch(secondResults, firstResults.length);
const compactFirstBatch = toolBatch(compactFirst, 0);
const compactSecondBatch = toolBatch(compactSecond, firstResults.length);
const retrievalResult = retrievalBatch(compactFirst[0].omissions[0]);

const boundedTwoRequestMessages = baselineMessages.map((message) =>
  message.role === 'user'
    ? {
        ...message,
        content: `${message.content}\nSynthetic plan: inspect one atom and one test, edit only those files, verify.`,
      }
    : message,
);

function body(messages, tools) {
  return {
    model: 'Qwen3.5-4B-Q4_K_M',
    messages,
    tools,
    stream: false,
    max_tokens: 1000,
  };
}

const requests = {
  currentFocus: [
    body(baselineMessages, currentTools),
    body([...baselineMessages, ...firstBatch], currentTools),
    body([...baselineMessages, ...firstBatch, ...secondBatch], currentTools),
  ],
  narrowProfile: [
    body(baselineMessages, narrowTools),
    body([...baselineMessages, ...firstBatch], narrowTools),
    body([...baselineMessages, ...firstBatch, ...secondBatch], narrowTools),
  ],
  narrowProfilePlusRetrievableCompaction: [
    body(baselineMessages, [...narrowTools, artifactRetrievalTool]),
    body(
      [...baselineMessages, ...compactFirstBatch],
      [...narrowTools, artifactRetrievalTool],
    ),
    body(
      [
        ...baselineMessages,
        ...compactFirstBatch,
        ...retrievalResult,
        ...compactSecondBatch,
      ],
      [...narrowTools, artifactRetrievalTool],
    ),
  ],
  boundedTwoRequestPlan: [
    body(boundedTwoRequestMessages, [...narrowTools, artifactRetrievalTool]),
    body(
      [
        ...boundedTwoRequestMessages,
        ...compactFirstBatch.slice(0, 6),
        ...retrievalResult,
        {
          role: 'assistant',
          content:
            'Synthetic completion: apply the focused edit and report changed paths.',
        },
        ...compactSecondBatch,
      ],
      [...narrowTools, artifactRetrievalTool],
    ),
  ],
  threeRequestGrowingHistory: [
    body(baselineMessages, [...narrowTools, artifactRetrievalTool]),
    body(
      [...baselineMessages, ...compactFirstBatch],
      [...narrowTools, artifactRetrievalTool],
    ),
    body(
      [
        ...baselineMessages,
        ...compactFirstBatch,
        ...retrievalResult,
        {
          role: 'assistant',
          content:
            'Synthetic completion: edit is ready; run targeted verification.',
        },
        ...compactSecondBatch,
      ],
      [...narrowTools, artifactRetrievalTool],
    ),
  ],
};

// Tokenizer-only corpus. No historical prompt, worker output, or tool arguments.
const tokenizeOnly = [];
for (const [group, tools] of [
  ['currentVisible', currentTools],
  [
    'currentReachableWithoutToolSearch',
    schemaOutput.schemas.currentReachableWithoutToolSearch,
  ],
  [
    'narrowProfileReachableWithoutToolSearch',
    schemaOutput.schemas.narrowProfileReachableWithoutToolSearch,
  ],
  ['narrowProfile', narrowTools],
  [
    'narrowProfilePlusRetrievableCompaction',
    [...narrowTools, artifactRetrievalTool],
  ],
]) {
  for (const tool of tools) {
    tokenizeOnly.push({
      kind: 'tool-schema',
      group,
      name: tool.function.name,
      content: JSON.stringify(tool),
      addSpecial: false,
    });
  }
  tokenizeOnly.push({
    kind: 'tool-schema-aggregate',
    group,
    content: JSON.stringify(tools),
    addSpecial: false,
  });
}

for (const [index, result] of syntheticToolResults.entries()) {
  const compacted = compactedResults[index];
  tokenizeOnly.push(
    {
      kind: 'synthetic-result-original',
      name: result.kind,
      content: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\nexit=${result.exitCode}`,
      addSpecial: false,
    },
    {
      kind: 'synthetic-result-compacted',
      name: result.kind,
      content: `${compacted.stdout}${compacted.stderr ? `\n${compacted.stderr}` : ''}\nexit=${compacted.exitCode}`,
      addSpecial: false,
    },
  );
}

await writeFile(
  corpusPath,
  `${JSON.stringify({
    syntheticFixedSystemTokens: 4_803,
    requests,
    tokenizeOnly,
  })}\n`,
  'utf8',
);
artifactStore.cleanupScope('synthetic-attempt-80');
artifactStore.close();
