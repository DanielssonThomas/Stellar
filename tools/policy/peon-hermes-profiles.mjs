export const defaultPeonHermesProfile = 'focus';

export const peonHermesProfileConfigFiles = Object.freeze({
  focus: 'peon-hermes-config.yaml',
  'narrow-coding': 'peon-hermes-narrow-config.yaml',
});

const profileLabelPrefix = 'hermes-profile:';
const narrowProfileLabel = `${profileLabelPrefix}narrow-coding`;
const workflowLabelPrefix = 'hermes-workflow:';
const boundedCodingWorkflowLabel = `${workflowLabelPrefix}bounded-coding`;
export const boundedCodingMaxForwardedRequests = 2;

function labelsOf(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label?.name,
  );
}

export function resolvePeonHermesProfile(issue) {
  const profileLabels = labelsOf(issue).filter((label) =>
    label?.startsWith(profileLabelPrefix),
  );
  if (profileLabels.length === 0) return defaultPeonHermesProfile;
  if (profileLabels.length !== 1 || profileLabels[0] !== narrowProfileLabel)
    throw new Error(
      'Peon issue has an unknown or ambiguous Hermes profile opt-in.',
    );

  const labels = labelsOf(issue);
  if (
    !labels.includes('worker:peon') ||
    !labels.includes('priority:low') ||
    !labels.includes('target:develop')
  )
    throw new Error(
      'The narrow Hermes profile requires a low-priority Peon issue targeting develop.',
    );
  return 'narrow-coding';
}

/** Resolve a closed workflow selection from fresh, trusted issue labels. */
export function resolvePeonHermesWorkflow(issue) {
  const workflowLabels = labelsOf(issue).filter((label) =>
    label?.startsWith(workflowLabelPrefix),
  );
  if (workflowLabels.length === 0) return 'standard';
  if (
    workflowLabels.length !== 1 ||
    workflowLabels[0] !== boundedCodingWorkflowLabel
  )
    throw new Error('Peon issue has an unknown or ambiguous workflow opt-in.');
  const labels = labelsOf(issue);
  if (
    !labels.includes('worker:peon') ||
    !labels.includes('priority:low') ||
    !labels.includes('target:develop') ||
    !labels.includes('hermes-profile:narrow-coding')
  )
    throw new Error(
      'The bounded-coding workflow requires a low-priority Peon issue targeting develop with the narrow-coding profile.',
    );
  return 'bounded-coding';
}

export function maxForwardedRequestsForWorkflow(workflow) {
  if (workflow === 'standard') return undefined;
  if (workflow === 'bounded-coding') return boundedCodingMaxForwardedRequests;
  throw new Error('Unknown trusted Peon workflow.');
}

export function peonHermesConfigFilename(profile = defaultPeonHermesProfile) {
  const filename = peonHermesProfileConfigFiles[profile];
  if (!Object.hasOwn(peonHermesProfileConfigFiles, profile))
    throw new Error('Unknown trusted Hermes tool profile.');
  return filename;
}

export function validatePeonHermesConfigSource(profile, source) {
  const filename = peonHermesConfigFilename(profile);
  if (
    typeof source !== 'string' ||
    !source.startsWith('/') ||
    !source.startsWith('/mnt/') ||
    source.includes(',') ||
    source.includes('\\') ||
    source.split('/').includes('..') ||
    source.split('/').at(-1) !== filename ||
    !source.endsWith(`/tools/policy/${filename}`)
  )
    throw new Error('Trusted Hermes config source does not match its profile.');
  return source;
}

export function assertMatchingHermesConfigDigest(trustedDigest, mountedDigest) {
  if (
    !/^[a-f0-9]{64}$/.test(trustedDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(mountedDigest ?? '') ||
    trustedDigest !== mountedDigest
  )
    throw new Error('Trusted Hermes config differs across Windows and WSL.');
  return trustedDigest;
}
