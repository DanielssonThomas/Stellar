import { readFile, writeFile } from 'node:fs/promises';
import { compactToolResult } from './context-study.mjs';
import { syntheticToolResults } from './synthetic-fixtures.mjs';

const [schemaPath, corpusPath] = process.argv.slice(2);
if (!schemaPath || !corpusPath)
  throw new Error('Usage: build-synthetic-corpus <schema-json> <corpus-json>');

const schemaOutput = JSON.parse(await readFile(schemaPath, 'utf8'));
const currentTools = schemaOutput.schemas.currentVisible;
const narrowTools = schemaOutput.schemas.narrowProfile;
const compactedResults = syntheticToolResults.map((result) =>
  compactToolResult(result),
);
const baselineMessages = [
  {
    role: 'system',
    content:
      'Synthetic fixed instructions: obey repository guidance, preserve security boundaries, and use trusted verification.',
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
  const assistant = { role: 'assistant', content: null, tool_calls: calls };
  const outputs = results.map((result, index) => ({
    role: 'tool',
    tool_call_id: calls[index].id,
    name: calls[index].function.name,
    content: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\nexit=${result.exitCode}`,
  }));
  return [assistant, ...outputs];
}

const firstResults = syntheticToolResults.slice(0, 5);
const secondResults = syntheticToolResults.slice(5);
const compactFirst = compactedResults.slice(0, 5);
const compactSecond = compactedResults.slice(5);

const firstBatch = toolBatch(firstResults, 0);
const secondBatch = toolBatch(secondResults, firstResults.length);
const compactFirstBatch = toolBatch(compactFirst, 0);
const compactSecondBatch = toolBatch(compactSecond, firstResults.length);

const checkpointSummary = [
  'Checkpoint (synthetic): directory listing had 1 unique path and 5 matching atom entries; search found avatar and loading references; command exit=0; repeated optional-cache warning count=4; exact source excerpt follows.',
  syntheticToolResults[4].stdout,
].join('\n');

function body(messages, tools) {
  return {
    model: 'Qwen3.5-4B-Q4_K_M',
    messages,
    tools,
    stream: false,
    max_tokens: 1000,
  };
}

const requests = {};
for (const [scenario, tools] of [
  ['currentFocus', currentTools],
  ['narrowProfile', narrowTools],
  ['narrowProfileCompacted', narrowTools],
  ['checkpointedFocus', currentTools],
]) {
  requests[scenario] = [
    body(baselineMessages, tools),
    body(
      scenario === 'checkpointedFocus'
        ? [
            ...baselineMessages,
            { role: 'assistant', content: checkpointSummary },
          ]
        : [
            ...baselineMessages,
            ...(scenario === 'narrowProfileCompacted'
              ? compactFirstBatch
              : firstBatch),
          ],
      tools,
    ),
    body(
      scenario === 'checkpointedFocus'
        ? [
            ...baselineMessages,
            { role: 'assistant', content: checkpointSummary },
            ...secondBatch,
          ]
        : [
            ...baselineMessages,
            ...(scenario === 'narrowProfileCompacted'
              ? compactFirstBatch
              : firstBatch),
            ...(scenario === 'narrowProfileCompacted'
              ? compactSecondBatch
              : secondBatch),
          ],
      tools,
    ),
  ];
}

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
  `${JSON.stringify({ requests, tokenizeOnly })}\n`,
  'utf8',
);
