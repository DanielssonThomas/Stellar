CREATE TABLE issues (
  number INTEGER PRIMARY KEY CHECK (number > 0),
  complexity TEXT CHECK (complexity IN ('small', 'medium', 'large'))
) STRICT;

CREATE TABLE budget_revisions (
  issue_number INTEGER NOT NULL REFERENCES issues(number),
  revision INTEGER NOT NULL CHECK (revision > 0),
  recorded_at TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens > 0),
  allocated_tokens INTEGER NOT NULL CHECK (allocated_tokens > 0),
  profile TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  evidence_json TEXT,
  PRIMARY KEY (issue_number, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('codex', 'hermes')),
  agent TEXT NOT NULL,
  issue_number INTEGER REFERENCES issues(number),
  parent_id TEXT,
  model TEXT,
  provider TEXT,
  reasoning TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_seen_at TEXT NOT NULL,
  status TEXT CHECK (status IN ('active', 'completed', 'failed', 'interrupted'))
) STRICT, WITHOUT ROWID;

CREATE TABLE retired_sessions (
  id TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL REFERENCES issues(number),
  observed_tokens INTEGER,
  usage_complete INTEGER NOT NULL CHECK (usage_complete IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE INDEX retired_sessions_by_issue ON retired_sessions(issue_number);

CREATE INDEX sessions_by_issue ON sessions(issue_number, started_at);
CREATE INDEX sessions_by_retention ON sessions(last_seen_at);

CREATE TABLE turns (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  status TEXT CHECK (status IN ('active', 'completed', 'failed', 'interrupted')),
  PRIMARY KEY (session_id, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE usage_streams (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('cumulative', 'delta')),
  model TEXT,
  provider TEXT,
  provenance TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE usage_observations (
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_tokens INTEGER CHECK (cached_tokens BETWEEN 0 AND input_tokens),
  cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens BETWEEN 0 AND output_tokens),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  PRIMARY KEY (session_id, stream_id, id),
  FOREIGN KEY (session_id, stream_id) REFERENCES usage_streams(session_id, id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX usage_by_stream ON usage_observations(session_id, stream_id, at DESC);

CREATE TABLE failures (
  fingerprint TEXT PRIMARY KEY,
  technology TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE attempts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  turn_id TEXT,
  at TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('build', 'test', 'lint', 'check', 'tool', 'ci')),
  technology TEXT,
  component TEXT,
  operation_id TEXT,
  exit_code INTEGER,
  diagnostic INTEGER NOT NULL CHECK (diagnostic IN (0, 1)),
  fingerprint TEXT REFERENCES failures(fingerprint),
  provenance TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX attempts_by_operation ON attempts(session_id, operation_id, at);
CREATE INDEX attempts_by_fingerprint ON attempts(fingerprint, at);
CREATE INDEX attempts_by_technology ON attempts(technology, component, at);

CREATE TABLE skill_versions (
  skill TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  static_tokens INTEGER CHECK (static_tokens >= 0),
  tokenizer TEXT,
  PRIMARY KEY (skill, version),
  UNIQUE (skill, content_hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE skill_states (
  skill TEXT NOT NULL,
  version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate', 'experimental', 'validated', 'maintained', 'retired', 'merged')),
  transfer_evidence TEXT,
  PRIMARY KEY (skill, version, recorded_at),
  FOREIGN KEY (skill, version) REFERENCES skill_versions(skill, version)
) STRICT, WITHOUT ROWID;

CREATE TABLE skill_activations (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  skill TEXT NOT NULL,
  version TEXT NOT NULL,
  at TEXT NOT NULL,
  loaded_tokens INTEGER CHECK (loaded_tokens >= 0),
  reference_tokens INTEGER CHECK (reference_tokens >= 0),
  discovery_tokens INTEGER CHECK (discovery_tokens >= 0),
  provenance TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (skill, version) REFERENCES skill_versions(skill, version)
) STRICT, WITHOUT ROWID;

CREATE INDEX activations_by_version ON skill_activations(skill, version, session_id);

CREATE TABLE interventions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'existing-skill', 'new-skill', 'validation-hook', 'ci-static-analysis',
    'code-generator', 'architecture', 'documentation', 'issue-specification', 'none'
  )),
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  implementation_ref TEXT NOT NULL,
  expected_improvement TEXT NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 90),
  model TEXT,
  reasoning TEXT,
  complexity TEXT CHECK (complexity IN ('small', 'medium', 'large'))
) STRICT, WITHOUT ROWID;

CREATE TABLE intervention_failures (
  intervention_id TEXT NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL REFERENCES failures(fingerprint),
  PRIMARY KEY (intervention_id, fingerprint)
) STRICT, WITHOUT ROWID;

CREATE TABLE intervention_evaluations (
  intervention_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (intervention_id, fingerprint, evaluated_at),
  FOREIGN KEY (intervention_id, fingerprint)
    REFERENCES intervention_failures(intervention_id, fingerprint)
) STRICT, WITHOUT ROWID;

CREATE TABLE allowance_observations (
  source TEXT NOT NULL,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  resets_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  used_percent REAL NOT NULL CHECK (used_percent BETWEEN 0 AND 100),
  PRIMARY KEY (source, window_minutes, resets_at, observed_at)
) STRICT, WITHOUT ROWID;
