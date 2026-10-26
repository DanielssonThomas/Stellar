export const defaultPeonHermesProfile = 'focus';

export const peonHermesProfileConfigFiles = Object.freeze({
  focus: 'peon-hermes-config.yaml',
  'narrow-coding': 'peon-hermes-narrow-config.yaml',
  'narrow-evidence': 'peon-hermes-evidence-config.yaml',
});

const profileLabelPrefix = 'hermes-profile:';
const narrowProfileLabel = `${profileLabelPrefix}narrow-coding`;
const evidenceProfileLabel = `${profileLabelPrefix}narrow-evidence`;
const workflowLabelPrefix = 'hermes-workflow:';
const boundedCodingWorkflowLabel = `${workflowLabelPrefix}bounded-coding`;
const editFirstExperimentLabel = `${workflowLabelPrefix}edit-first-4`;
export const boundedCodingMaxForwardedRequests = 2;
export const editFirstExperimentMaxForwardedRequests = 4;

export function isPreparedPeonWorkflow(workflow) {
  return workflow === 'bounded-coding' || workflow === 'edit-first-4';
}

export function modelTokenLimitForWorkflow(workflow) {
  if (workflow === 'edit-first-4') return 52_000;
  if (workflow === 'standard' || workflow === 'bounded-coding') return 32_000;
  throw new Error('Unknown trusted Peon workflow.');
}

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
  if (
    profileLabels.length !== 1 ||
    ![narrowProfileLabel, evidenceProfileLabel].includes(profileLabels[0])
  )
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
  if (
    profileLabels[0] === evidenceProfileLabel &&
    (issue.number !== 50 || !labels.includes(editFirstExperimentLabel))
  )
    throw new Error(
      'The evidence profile requires issue #50 and its four-request workflow.',
    );
  return profileLabels[0] === evidenceProfileLabel
    ? 'narrow-evidence'
    : 'narrow-coding';
}

/** Resolve a closed workflow selection from fresh, trusted issue labels. */
export function resolvePeonHermesWorkflow(issue) {
  const workflowLabels = labelsOf(issue).filter((label) =>
    label?.startsWith(workflowLabelPrefix),
  );
  if (workflowLabels.length === 0) return 'standard';
  if (
    workflowLabels.length !== 1 ||
    ![boundedCodingWorkflowLabel, editFirstExperimentLabel].includes(
      workflowLabels[0],
    )
  )
    throw new Error('Peon issue has an unknown or ambiguous workflow opt-in.');
  const labels = labelsOf(issue);
  if (
    !labels.includes('worker:peon') ||
    !labels.includes('priority:low') ||
    !labels.includes('target:develop') ||
    !labels.includes(
      workflowLabels[0] === editFirstExperimentLabel
        ? evidenceProfileLabel
        : narrowProfileLabel,
    )
  )
    throw new Error(
      'The bounded-coding workflow requires a low-priority Peon issue targeting develop with the narrow-coding profile.',
    );
  if (workflowLabels[0] === editFirstExperimentLabel && issue.number !== 50)
    throw new Error('The four-request experiment is restricted to issue #50.');
  return workflowLabels[0] === editFirstExperimentLabel
    ? 'edit-first-4'
    : 'bounded-coding';
}

export function maxForwardedRequestsForWorkflow(workflow) {
  if (workflow === 'standard') return undefined;
  if (workflow === 'bounded-coding') return boundedCodingMaxForwardedRequests;
  if (workflow === 'edit-first-4')
    return editFirstExperimentMaxForwardedRequests;
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
