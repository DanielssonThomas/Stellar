import { digest, isText } from './engineering-org/planning-evidence.mjs';

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function ruleInventory(rules) {
  if (
    !Array.isArray(rules) ||
    !rules.length ||
    !rules.every(
      (rule) =>
        object(rule) &&
        isText(rule.type) &&
        Object.keys(rule).every((key) => ['type', 'parameters'].includes(key)),
    ) ||
    new Set(rules.map((rule) => rule.type)).size !== rules.length
  )
    return null;
  return rules
    .map((rule) =>
      digest({ type: rule.type, parameters: rule.parameters ?? null }),
    )
    .sort();
}

export function assessIntegrationProtection(branchRules, rulesets, classic) {
  const reasons = new Set();
  const requirements = new Map();
  let pullRequired = false;
  let threadsRequired = false;
  const deny = (code) => reasons.add(code);
  for (const source of rulesets) {
    const declared = ruleInventory(source.rules);
    const effective = ruleInventory(
      branchRules
        .filter((rule) => rule.ruleset_id === source.id)
        .map((rule) => ({
          type: rule.type,
          parameters: rule.parameters ?? null,
        })),
    );
    if (!declared || !effective || digest(declared) !== digest(effective))
      deny('ruleset-rule-coverage-incomplete');
  }
  const addCheck = (name, appId) => {
    if (
      !isText(name) ||
      (appId !== null &&
        appId !== undefined &&
        appId !== -1 &&
        !positive(appId))
    ) {
      deny('required-check-policy-malformed');
      return;
    }
    if (!requirements.has(name)) requirements.set(name, new Set());
    if (positive(appId)) requirements.get(name).add(appId);
  };
  const reviews = (parameters, ruleset) => {
    if (!object(parameters)) {
      deny('review-policy-malformed');
      return;
    }
    const keys = ruleset
      ? [
          'dismiss_stale_reviews_on_push',
          'require_code_owner_review',
          'require_last_push_approval',
          'required_review_thread_resolution',
        ]
      : [
          'dismiss_stale_reviews',
          'require_code_owner_reviews',
          'require_last_push_approval',
        ];
    if (
      !keys.every((key) => typeof parameters[key] === 'boolean') ||
      !Number.isSafeInteger(parameters.required_approving_review_count) ||
      parameters.required_approving_review_count < 0
    )
      deny('review-policy-malformed');
    if (
      parameters.required_approving_review_count !== 0 ||
      parameters[keys[1]] !== false ||
      parameters.require_last_push_approval !== false ||
      (parameters.required_reviewers?.length ?? 0) > 0 ||
      parameters.dismissal_restriction?.enabled === true
    )
      deny('review-policy-unsupported');
    if (ruleset && parameters.required_review_thread_resolution === true)
      threadsRequired = true;
    if (
      parameters.allowed_merge_methods !== undefined &&
      (!Array.isArray(parameters.allowed_merge_methods) ||
        !parameters.allowed_merge_methods.includes('squash'))
    )
      deny('squash-merge-not-authorized');
    if (ruleset) {
      const supported = [
        ...keys,
        'required_approving_review_count',
        'allowed_merge_methods',
        'require_extra_approval_for_unattributed_changes',
        'required_reviewers',
        'dismissal_restriction',
      ];
      if (
        Object.keys(parameters).some((key) => !supported.includes(key)) ||
        (parameters.required_reviewers !== undefined &&
          !Array.isArray(parameters.required_reviewers)) ||
        (parameters.require_extra_approval_for_unattributed_changes !==
          undefined &&
          parameters.require_extra_approval_for_unattributed_changes !== false)
      )
        deny('review-policy-unsupported');
    }
  };
  for (const rule of branchRules) {
    const source = rulesets.find((entry) => entry.id === rule.ruleset_id);
    if (
      !positive(rule.ruleset_id) ||
      !['Repository', 'Organization', 'Enterprise'].includes(
        rule.ruleset_source_type,
      ) ||
      !isText(rule.ruleset_source) ||
      !source ||
      source.source !== rule.ruleset_source ||
      source.source_type !== rule.ruleset_source_type ||
      source.enforcement !== 'active' ||
      source.target !== 'branch' ||
      !Array.isArray(source.rules) ||
      !source.rules.some(
        (entry) =>
          entry.type === rule.type &&
          digest(entry.parameters ?? null) === digest(rule.parameters ?? null),
      )
    )
      deny('ruleset-provenance-incomplete');
    if (!Array.isArray(source?.bypass_actors))
      deny('ruleset-bypass-evidence-unavailable');
    else if (source.bypass_actors.length) deny('ruleset-bypass-unsupported');
    if (rule.type === 'required_status_checks') {
      const parameters = rule.parameters;
      if (
        !object(parameters) ||
        typeof parameters.strict_required_status_checks_policy !== 'boolean' ||
        !Array.isArray(parameters.required_status_checks) ||
        !parameters.required_status_checks.length
      ) {
        deny('required-check-policy-malformed');
        continue;
      }
      if (
        Object.keys(parameters).some(
          (key) =>
            ![
              'strict_required_status_checks_policy',
              'required_status_checks',
              'do_not_enforce_on_create',
            ].includes(key),
        ) ||
        (parameters.do_not_enforce_on_create !== undefined &&
          typeof parameters.do_not_enforce_on_create !== 'boolean')
      )
        deny('required-check-policy-unsupported');
      for (const check of parameters.required_status_checks)
        addCheck(check?.context, check?.integration_id);
    } else if (rule.type === 'pull_request') {
      pullRequired = true;
      reviews(rule.parameters, true);
    } else if (
      ![
        'creation',
        'deletion',
        'non_fast_forward',
        'required_linear_history',
      ].includes(rule.type) ||
      (rule.parameters && Object.keys(rule.parameters).length)
    )
      deny('branch-rule-unsupported');
  }
  if (!object(classic) || typeof classic.enforce_admins?.enabled !== 'boolean')
    deny('classic-protection-malformed');
  else {
    if (classic.enforce_admins.enabled !== true)
      deny('classic-admin-bypass-unsupported');
    if (
      classic.required_pull_request_reviews !== null &&
      classic.required_pull_request_reviews !== undefined
    ) {
      pullRequired = true;
      reviews(classic.required_pull_request_reviews, false);
      const bypass =
        classic.required_pull_request_reviews.bypass_pull_request_allowances;
      if (
        bypass &&
        (!object(bypass) ||
          Object.values(bypass).some(
            (entries) => !Array.isArray(entries) || entries.length,
          ))
      )
        deny('classic-review-bypass-unsupported');
    }
    const status = classic.required_status_checks;
    if (status !== null && status !== undefined) {
      if (
        !object(status) ||
        typeof status.strict !== 'boolean' ||
        !Array.isArray(status.contexts) ||
        !Array.isArray(status.checks)
      )
        deny('required-check-policy-malformed');
      else {
        for (const context of status.contexts) addCheck(context, null);
        for (const check of status.checks)
          addCheck(check?.context, check?.app_id);
      }
    }
    for (const key of [
      'required_conversation_resolution',
      'required_signatures',
      'required_linear_history',
      'allow_force_pushes',
      'allow_deletions',
      'block_creations',
      'lock_branch',
      'allow_fork_syncing',
    ]) {
      if (
        classic[key] !== undefined &&
        (!object(classic[key]) || typeof classic[key].enabled !== 'boolean')
      )
        deny('classic-protection-malformed');
    }
    threadsRequired ||=
      classic.required_conversation_resolution?.enabled === true;
    if (
      classic.required_signatures?.enabled === true ||
      classic.lock_branch?.enabled === true ||
      classic.restrictions != null
    )
      deny('classic-protection-unsupported');
    const supported = [
      'url',
      'required_status_checks',
      'enforce_admins',
      'required_pull_request_reviews',
      'restrictions',
      'required_signatures',
      'required_linear_history',
      'allow_force_pushes',
      'allow_deletions',
      'block_creations',
      'required_conversation_resolution',
      'lock_branch',
      'allow_fork_syncing',
    ];
    if (Object.keys(classic).some((key) => !supported.includes(key)))
      deny('classic-protection-unsupported');
  }
  if (!pullRequired) deny('pull-request-protection-missing');
  if (!requirements.has('verify')) deny('required-verify-protection-missing');
  const requiredChecks = [...requirements]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, apps]) => {
      if (apps.size !== 1)
        deny(
          apps.size
            ? 'required-check-source-conflict'
            : 'required-check-source-unpinned',
        );
      return { name, appId: apps.size === 1 ? [...apps][0] : null };
    });
  return { requiredChecks, threadsRequired, reasons: [...reasons].sort() };
}
