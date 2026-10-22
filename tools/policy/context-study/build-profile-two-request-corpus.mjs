import { readFile, writeFile } from 'node:fs/promises';
import { syntheticToolResults } from './synthetic-fixtures.mjs';

const [schemaPath, corpusPath] = process.argv.slice(2);
if (!schemaPath || !corpusPath)
  throw new Error(
    'Usage: build-profile-two-request-corpus <schema-json> <corpus-json>',
  );

const schemaOutput = JSON.parse(await readFile(schemaPath, 'utf8'));
const focusTools = schemaOutput.schemas.currentVisible;
const narrowTools = schemaOutput.schemas.narrowProfile;
const baseMessages = [
  { role: 'system', content: '__SYNTHETIC_FIXED_SYSTEM__' },
  {
    role: 'user',
    content:
      'Synthetic issue task: inspect one shared UI component and its test, make the smallest requested edit, run scoped checks, and report. Follow assigned issue instructions.',
  },
];

function resultMessages(results, offset = 0) {
  const names = ['terminal', 'search_files', 'read_file', 'terminal'];
  const calls = results.map((result, index) => ({
    id: `synthetic-profile-call-${offset + index + 1}`,
    type: 'function',
    function: {
      name: names[index % names.length],
      arguments: JSON.stringify({ query: `synthetic-inspection-${index + 1}` }),
    },
  }));
  return [
    {
      role: 'assistant',
      content:
        'Synthetic assistant: I will use the inspected component convention and make a scoped change.',
      tool_calls: calls,
    },
    ...results.map((result, index) => ({
      role: 'tool',
      tool_call_id: calls[index].id,
      name: calls[index].function.name,
      content: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\nexit=${result.exitCode}`,
    })),
  ];
}

function request(messages, tools) {
  return {
    model: 'Qwen3.5-4B-Q4_K_M',
    messages,
    tools,
    stream: false,
    max_tokens: 1000,
  };
}

const broadDiscovery = resultMessages(syntheticToolResults.slice(0, 5));
const boundedDiscovery = resultMessages(syntheticToolResults.slice(0, 2));
const boundedMessages = [
  baseMessages[0],
  {
    ...baseMessages[1],
    content: `${baseMessages[1].content} Plan: inspect the named component and nearest test, edit only those files, then run specified scoped checks.`,
  },
];
const requests = {
  existingFocus: [
    request(baseMessages, focusTools),
    request([...baseMessages, ...broadDiscovery], focusTools),
  ],
  scopedNarrow: [
    request(baseMessages, narrowTools),
    request([...baseMessages, ...broadDiscovery], narrowTools),
  ],
  scopedNarrowBoundedPlan: [
    request(boundedMessages, narrowTools),
    request([...boundedMessages, ...boundedDiscovery], narrowTools),
  ],
};

const tokenizeOnly = [];
for (const [group, tools] of [
  ['currentVisible', focusTools],
  ['narrowProfile', narrowTools],
]) {
  for (const schema of tools)
    tokenizeOnly.push({
      kind: 'tool-schema',
      group,
      name: schema.function.name,
      content: JSON.stringify(schema),
      addSpecial: false,
    });
  tokenizeOnly.push({
    kind: 'tool-schema-aggregate',
    group,
    content: JSON.stringify(tools),
    addSpecial: false,
  });
}

await writeFile(
  corpusPath,
  `${JSON.stringify({
    syntheticFixedSystemTokens: 4_803,
    requests,
    tokenizeOnly,
    endpointClass: 'synthetic-only-tokenize-and-apply-template',
  })}\n`,
  'utf8',
);
