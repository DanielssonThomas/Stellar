const nonCompactKinds = new Set(['source', 'test-failure', 'build-failure']);

/**
 * Prototype only: coalesce exact consecutive stdout duplicates while retaining
 * a location handle into the trusted full-output artifact. Failure diagnostics,
 * stderr, and source excerpts are kept byte-for-byte.
 */
export function compactToolResult({
  kind,
  stdout,
  stderr = '',
  exitCode,
  artifactStore,
  scope,
}) {
  if (typeof stdout !== 'string' || typeof stderr !== 'string')
    throw new TypeError('Tool output must be text.');

  if (nonCompactKinds.has(kind))
    return { stdout, stderr, exitCode, omissions: [] };

  const lines = stdout.split('\n');
  const runs = [];
  for (let index = 0; index < lines.length; ) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    if (end - index >= 3 && lines[index].trim())
      runs.push({ index, end, firstLine: index + 1, lastLine: end });
    index = end;
  }
  let artifactId;
  if (runs.length) {
    if (!artifactStore || typeof artifactStore.put !== 'function')
      throw new TypeError(
        'A trusted artifact store is required for compaction.',
      );
    if (typeof scope !== 'string')
      throw new TypeError('An attempt scope is required for artifact storage.');
    artifactId = artifactStore.put(scope, stdout);
  }
  if (runs.length && !/^[a-f0-9]{32}$/.test(artifactId ?? ''))
    throw new TypeError('A safe opaque artifact identifier is required.');

  const output = [];
  const omissions = [];
  let cursor = 0;
  for (const run of runs) {
    output.push(...lines.slice(cursor, run.index));
    output.push(lines[run.index]);
    output.push(
      `[coalesced=${run.end - run.index - 1} exact repeats; retrieve ${artifactId}:${run.firstLine}-${run.lastLine}]`,
    );
    omissions.push({
      artifactId,
      firstLine: run.firstLine,
      lastLine: run.lastLine,
      repeatCount: run.end - run.index,
    });
    cursor = run.end;
  }
  output.push(...lines.slice(cursor));
  return { stdout: output.join('\n'), stderr, exitCode, omissions };
}

/** Retrieve the precise omitted line range from the task-scoped trusted store. */
export function retrieveCompactedRange(artifactStore, scope, omission) {
  if (!artifactStore || typeof artifactStore.retrieve !== 'function')
    throw new TypeError('A trusted artifact store is required.');
  return artifactStore.retrieve(scope, omission.artifactId, {
    firstLine: omission.firstLine,
    lastLine: omission.lastLine,
  });
}

export function retrieveOriginalLines(text, { firstLine, lastLine }) {
  if (
    !Number.isInteger(firstLine) ||
    !Number.isInteger(lastLine) ||
    firstLine < 1 ||
    lastLine < firstLine
  )
    throw new TypeError('Invalid original line range.');
  return text
    .split('\n')
    .slice(firstLine - 1, lastLine)
    .join('\n');
}

/** Return only schemas allowed by a synthetic task-scoped profile. */
export function filterToolSchemas(schemas, allowedNames) {
  const allowed = new Set(allowedNames);
  const seen = new Set();
  return schemas.filter((schema) => {
    const name = schema?.function?.name;
    if (!name || seen.has(name))
      throw new TypeError('Tool schema names must be present and unique.');
    seen.add(name);
    return allowed.has(name);
  });
}

/**
 * Project historical prompt anchors using only a discounted share of measured
 * synthetic savings. Future prompt growth is supplied explicitly per request.
 */
export function projectRequests({
  baselinePrompts,
  schemaSavings = [],
  resultSavings = [],
  checkpointSavings = [],
  transferFactor = 0.5,
  completionReserve,
}) {
  if (!Array.isArray(baselinePrompts) || baselinePrompts.length === 0)
    throw new TypeError('At least one baseline prompt is required.');
  if (
    !Number.isFinite(transferFactor) ||
    transferFactor < 0 ||
    transferFactor > 1
  )
    throw new TypeError('transferFactor must be between zero and one.');
  let cumulative = 0;
  let previousPrompt = 0;
  return baselinePrompts.map((baselinePrompt, index) => {
    const savings =
      (schemaSavings[index] ?? 0) +
      (resultSavings[index] ?? 0) +
      (checkpointSavings[index] ?? 0);
    const promptTokens = Math.max(
      0,
      Math.round(baselinePrompt - savings * transferFactor),
    );
    const completionTokens = completionReserve;
    cumulative += promptTokens + completionTokens;
    const request = {
      request: index + 1,
      promptTokens,
      promptGrowth: index === 0 ? 0 : promptTokens - previousPrompt,
      completionTokens,
      cumulativeTokens: cumulative,
    };
    previousPrompt = promptTokens;
    return request;
  });
}
