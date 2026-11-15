CREATE VIEW engineering_usage AS
WITH ordered AS (
  SELECT o.*, s.mode, s.model, s.provider, s.provenance,
    ROW_NUMBER() OVER (
      PARTITION BY o.session_id, o.stream_id
      ORDER BY CASE WHEN s.mode = 'cumulative' THEN o.total_tokens END DESC,
        o.at DESC, o.complete DESC, o.id DESC
    ) AS sample_rank
  FROM usage_observations o
  JOIN usage_streams s ON s.session_id = o.session_id AND s.id = o.stream_id
)
SELECT session_id, stream_id, model, provider, provenance,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  CASE WHEN COUNT(cached_tokens) = COUNT(*) THEN SUM(cached_tokens) END AS cached_tokens,
  CASE WHEN COUNT(cached_tokens) = COUNT(*) THEN SUM(input_tokens - cached_tokens) END AS uncached_tokens,
  CASE WHEN COUNT(cache_write_tokens) = COUNT(*) THEN SUM(cache_write_tokens) END AS cache_write_tokens,
  CASE WHEN COUNT(reasoning_tokens) = COUNT(*) THEN SUM(reasoning_tokens) END AS reasoning_tokens,
  SUM(total_tokens) AS observed_tokens, MAX(CASE WHEN sample_rank = 1 THEN complete END) AS complete
FROM ordered
WHERE mode = 'delta' OR sample_rank = 1
GROUP BY session_id, stream_id;

CREATE VIEW engineering_sessions AS
WITH usage AS (
  SELECT session_id, SUM(observed_tokens) AS observed_tokens,
    CASE WHEN COUNT(cached_tokens) = COUNT(*) THEN SUM(cached_tokens) END AS cached_tokens,
    CASE WHEN COUNT(uncached_tokens) = COUNT(*) THEN SUM(uncached_tokens) END AS uncached_tokens,
    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    MIN(complete) AS usage_complete
  FROM engineering_usage GROUP BY session_id
), counts AS (
  SELECT session_id, COUNT(*) AS attempts,
    SUM(exit_code <> 0 AND diagnostic = 0) AS failures,
    SUM(exit_code <> 0 AND diagnostic = 1) AS diagnostic_failures
  FROM attempts GROUP BY session_id
)
SELECT s.*, u.observed_tokens, u.cached_tokens, u.uncached_tokens, u.input_tokens,
  u.output_tokens, COALESCE(u.usage_complete, 0) AS usage_complete,
  COALESCE(c.attempts, 0) AS attempts, COALESCE(c.failures, 0) AS failures,
  COALESCE(c.diagnostic_failures, 0) AS diagnostic_failures
FROM sessions s
LEFT JOIN usage u ON u.session_id = s.id
LEFT JOIN counts c ON c.session_id = s.id;

CREATE VIEW engineering_budget AS
WITH usage AS (
  SELECT issue_number, SUM(observed_tokens) AS observed_tokens,
    SUM(usage_complete) AS complete_sessions, COUNT(*) AS session_count
  FROM (
    SELECT issue_number, observed_tokens, usage_complete FROM engineering_sessions
    WHERE issue_number IS NOT NULL
    UNION ALL
    SELECT issue_number, observed_tokens, usage_complete FROM retired_sessions
  )
  GROUP BY issue_number
), latest AS (
  SELECT issue_number, MAX(revision) AS revision FROM budget_revisions GROUP BY issue_number
)
SELECT i.number AS issue_number, b.estimated_tokens AS baseline_tokens,
  r.estimated_tokens, r.allocated_tokens, r.profile, r.confidence, r.revision,
  r.recorded_at, u.observed_tokens, COALESCE(u.complete_sessions, 0) AS complete_sessions,
  COALESCE(u.session_count, 0) AS session_count,
  u.observed_tokens - b.estimated_tokens AS observed_variance,
  CASE WHEN u.complete_sessions = u.session_count
    THEN u.observed_tokens - b.estimated_tokens END AS baseline_variance,
  CASE WHEN u.observed_tokens > r.allocated_tokens THEN 1
       WHEN u.complete_sessions = u.session_count AND r.allocated_tokens IS NOT NULL THEN 0
  END AS over_budget
FROM issues i
LEFT JOIN latest l ON l.issue_number = i.number
LEFT JOIN budget_revisions r ON r.issue_number = i.number AND r.revision = l.revision
LEFT JOIN budget_revisions b ON b.issue_number = i.number AND b.revision = 1
LEFT JOIN usage u ON u.issue_number = i.number;

CREATE VIEW engineering_failures AS
SELECT f.fingerprint, f.technology, a.component, f.code, f.description,
  a.session_id, s.issue_number, s.agent, s.model, a.at, a.category, a.diagnostic,
  a.provenance,
  CASE WHEN a.operation_id IS NOT NULL AND a.diagnostic = 0 THEN EXISTS (
    SELECT 1 FROM attempts prior
    WHERE prior.session_id = a.session_id AND prior.operation_id = a.operation_id
      AND prior.fingerprint = a.fingerprint AND prior.diagnostic = 0 AND prior.at < a.at
  ) END AS retry,
  CASE WHEN a.operation_id IS NOT NULL AND a.diagnostic = 0 THEN EXISTS (
    SELECT 1 FROM attempts later
    WHERE later.session_id = a.session_id AND later.operation_id = a.operation_id
      AND later.exit_code = 0 AND later.diagnostic = 0 AND later.at > a.at
  ) END AS resolved
FROM attempts a JOIN failures f ON f.fingerprint = a.fingerprint
JOIN sessions s ON s.id = a.session_id;

CREATE VIEW engineering_candidates AS
SELECT fingerprint, technology, code, description, COUNT(*) AS occurrences,
  COUNT(DISTINCT issue_number) AS issues, COUNT(DISTINCT session_id) AS sessions,
  SUM(retry) AS retries,
  CASE WHEN SUM(category IN ('lint', 'ci')) > 0 THEN 'ci-static-analysis'
       WHEN SUM(category = 'test') > 0 THEN 'validation-hook'
       ELSE 'documentation'
  END AS investigation_start
FROM engineering_failures
WHERE diagnostic = 0
GROUP BY fingerprint
HAVING COUNT(*) >= 2;

CREATE VIEW engineering_skills AS
WITH latest AS (
  SELECT skill, version, MAX(recorded_at) AS recorded_at
  FROM skill_states GROUP BY skill, version
), activations AS (
  SELECT skill, version, COUNT(*) AS activations, SUM(loaded_tokens) AS loaded_tokens,
    SUM(reference_tokens) AS reference_tokens, SUM(discovery_tokens) AS discovery_tokens
  FROM skill_activations GROUP BY skill, version
), correlated AS (
  SELECT u.skill, u.version, SUM(s.failures) AS failures,
    SUM((SELECT SUM(f.retry) FROM engineering_failures f WHERE f.session_id = s.id)) AS retries
  FROM (SELECT DISTINCT skill, version, session_id FROM skill_activations) u
  JOIN engineering_sessions s ON s.id = u.session_id
  GROUP BY u.skill, u.version
)
SELECT v.*, l.state, l.transfer_evidence, COALESCE(a.activations, 0) AS activations,
  a.loaded_tokens, a.reference_tokens, a.discovery_tokens, c.failures, c.retries
FROM skill_versions v
LEFT JOIN latest t ON t.skill = v.skill AND t.version = v.version
LEFT JOIN skill_states l ON l.skill = t.skill AND l.version = t.version AND l.recorded_at = t.recorded_at
LEFT JOIN activations a ON a.skill = v.skill AND a.version = v.version
LEFT JOIN correlated c ON c.skill = v.skill AND c.version = v.version;

CREATE VIEW engineering_interventions AS
WITH affected AS (
  SELECT DISTINCT fingerprint, component, category FROM engineering_failures WHERE diagnostic = 0
), exposures AS (
  SELECT i.id, f.fingerprint, a.session_id, a.id AS attempt_id,
    CAST(julianday(a.at) >= julianday(i.started_at) AS INTEGER) AS after,
    a.fingerprint = f.fingerprint AS failed,
    CASE WHEN a.fingerprint = f.fingerprint AND a.operation_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM attempts prior WHERE prior.session_id = a.session_id
        AND prior.operation_id = a.operation_id AND prior.fingerprint = f.fingerprint
        AND prior.diagnostic = 0 AND prior.at < a.at
    ) END AS retry
  FROM interventions i
  JOIN intervention_failures f ON f.intervention_id = i.id
  JOIN failures sig ON sig.fingerprint = f.fingerprint
  JOIN attempts a ON a.technology = sig.technology AND a.diagnostic = 0
    AND a.exit_code IS NOT NULL
    AND julianday(a.at) >= julianday(i.started_at) - i.window_days
    AND julianday(a.at) < julianday(i.started_at) + i.window_days
  JOIN sessions s ON s.id = a.session_id
  LEFT JOIN issues issue ON issue.number = s.issue_number
  WHERE (i.model IS NULL OR s.model = i.model)
    AND (i.reasoning IS NULL OR s.reasoning = i.reasoning)
    AND (i.complexity IS NULL OR issue.complexity = i.complexity)
    AND EXISTS (
      SELECT 1 FROM affected x
      WHERE x.fingerprint = f.fingerprint AND x.category = a.category AND x.component IS a.component
    )
), counts AS (
  SELECT id, fingerprint, after, COUNT(*) AS attempts, COUNT(DISTINCT session_id) AS sessions,
    SUM(COALESCE(failed, 0)) AS failures, SUM(retry) AS retries
  FROM exposures GROUP BY id, fingerprint, after
), tokens AS (
  SELECT e.id, e.fingerprint, e.after, SUM(s.observed_tokens) AS observed_tokens
  FROM (SELECT DISTINCT id, fingerprint, after, session_id FROM exposures) e
  JOIN engineering_sessions s ON s.id = e.session_id
  GROUP BY e.id, e.fingerprint, e.after
)
SELECT i.id, f.fingerprint, i.kind, i.version, i.started_at, i.implementation_ref,
  i.expected_improvement, i.window_days, i.model, i.reasoning, i.complexity,
  b.attempts AS before_attempts, a.attempts AS after_attempts,
  b.failures AS before_failures, a.failures AS after_failures,
  b.sessions AS before_sessions, a.sessions AS after_sessions,
  b.retries AS before_retries, a.retries AS after_retries,
  bt.observed_tokens AS before_observed_tokens, at.observed_tokens AS after_observed_tokens,
  1.0 * b.failures / b.attempts AS before_failure_rate,
  1.0 * a.failures / a.attempts AS after_failure_rate,
  CASE WHEN b.sessions IS NULL OR a.sessions IS NULL THEN 'incomplete'
       WHEN b.sessions < 5 OR a.sessions < 5 THEN 'limited'
       ELSE 'observational'
  END AS evidence_status
FROM interventions i
JOIN intervention_failures f ON f.intervention_id = i.id
LEFT JOIN counts b ON b.id = i.id AND b.fingerprint = f.fingerprint AND b.after = 0
LEFT JOIN counts a ON a.id = i.id AND a.fingerprint = f.fingerprint AND a.after = 1
LEFT JOIN tokens bt ON bt.id = i.id AND bt.fingerprint = f.fingerprint AND bt.after = 0
LEFT JOIN tokens at ON at.id = i.id AND at.fingerprint = f.fingerprint AND at.after = 1;
