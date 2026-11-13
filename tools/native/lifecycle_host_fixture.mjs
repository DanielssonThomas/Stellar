// Copy reviewed synthetic producer examples; never import or apply host code.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [producer, output] = process.argv.slice(2);
if (!producer || !output)
  throw new Error('Expected producer root and output path');
function pinned(path, expected) {
  const bytes = readFileSync(resolve(producer, path));
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Reviewed producer artifact mismatch');
  return JSON.parse(bytes.toString('utf8'));
}
const interfaceSha256 =
  '392c027ac8a5ba92873b1d0958a255bfb6cdd73f2a11b5d7b8ac3b97f066821e';
const qualificationSha256 =
  'ea9bec088243c4776d3104d438b825aa734a07debbddb13affe97e2cb8ea8d0f';
const wire = pinned(
  'config/hermes-compat/stellar-background-v1/host-interface-v1.json',
  interfaceSha256,
);
const qualification = pinned(
  'artifacts/issue-339/host-ports-20261112/qualification.json',
  qualificationSha256,
);
if (
  qualification.syntheticContext !== true ||
  qualification.installedCapability !== false ||
  qualification.liveIvyOrModelUsed !== false ||
  qualification.passed !== true
)
  throw new Error('Expected inactive synthetic qualification');
writeFileSync(
  output,
  JSON.stringify(
    {
      producerCheckpoint: '474c1b80f0fc33063895812c2af48b7cdc58ef08',
      syntheticContext: true,
      installedCapability: false,
      interfaceSha256,
      qualificationSha256,
      rpcMethods: wire.rpcMethods,
      examples: qualification.examples,
    },
    null,
    2,
  ) + '\n',
);
