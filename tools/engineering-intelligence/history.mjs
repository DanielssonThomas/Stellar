import { transaction, withDatabase } from './database.mjs';
import { sessionId } from './store.mjs';
import {
  choice,
  complexities,
  identifier,
  integer,
  timestamp,
  tokenCount,
} from './values.mjs';
import { digest } from './diagnostics.mjs';

function issueNumber(number) {
  return integer(number, 'issue number', 1, 2_147_483_647);
}

function publicText(value, label, maxLength, optional = false) {
  if (value == null && optional) return null;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    /(?:\bsk-|\bgh[opusr]_|github_pat_|xox[baprs]-)/i.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

export function recordBudget(
  dbPath,
  number,
  revisions,
  complexity,
  { allowHistoricalPrefix = false } = {},
) {
  const issue = issueNumber(number);
  if (!Array.isArray(revisions) || revisions.length > 200)
    throw new Error('Invalid budget revisions');
  return withDatabase(dbPath, (db) =>
    transaction(db, () => {
      db.prepare(
        `INSERT INTO issues(number, complexity) VALUES (?, ?)
      ON CONFLICT(number) DO UPDATE SET complexity = COALESCE(excluded.complexity, issues.complexity)`,
      ).run(issue, choice(complexity, 'issue complexity', complexities, true));
      const existing = db
        .prepare(
          `SELECT * FROM budget_revisions
      WHERE issue_number = ? ORDER BY revision`,
        )
        .all(issue);
      if (!allowHistoricalPrefix && existing.length > revisions.length)
        throw new Error('Budget history cannot be removed');
      let previousDate;
      let additions = 0;
      for (const [index, entry] of revisions.entries()) {
        if (entry.revision !== index + 1)
          throw new Error('Budget revisions must be contiguous');
        const at = timestamp(entry.recordedAt);
        if (previousDate && at < previousDate)
          throw new Error('Budget revisions must be chronological');
        previousDate = at;
        const estimated = integer(
          entry.estimatedTokens,
          'estimate',
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const allocated = integer(
          entry.allocatedTokens,
          'allocation',
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const profile = publicText(entry.profile, 'budget profile', 240);
        const confidence = choice(entry.confidence, 'confidence', [
          'low',
          'medium',
          'high',
        ]);
        if (
          entry.evidence != null &&
          (!Array.isArray(entry.evidence) || entry.evidence.length > 10)
        ) {
          throw new Error('Invalid budget evidence');
        }
        // Preserve evidence identity without copying issue free text into local telemetry.
        const evidence =
          entry.evidence == null
            ? null
            : JSON.stringify(
                entry.evidence.map((line) =>
                  digest(publicText(line, 'budget evidence', 240)),
                ),
              );
        const saved = existing[index];
        if (saved) {
          if (
            saved.recorded_at !== at ||
            saved.estimated_tokens !== estimated ||
            saved.allocated_tokens !== allocated ||
            saved.profile !== profile ||
            saved.confidence !== confidence ||
            saved.evidence_json !== evidence
          ) {
            throw new Error('Existing budget revision is immutable');
          }
          continue;
        }
        db.prepare(
          'INSERT INTO budget_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          issue,
          entry.revision,
          at,
          estimated,
          allocated,
          profile,
          confidence,
          evidence,
        );
        additions++;
      }
      return additions;
    }),
  );
}

const skillStates = [
  'candidate',
  'experimental',
  'validated',
  'maintained',
  'retired',
  'merged',
];
export function recordSkill(dbPath, entry) {
  const skill = identifier(entry.skill, 'skill');
  const version = identifier(entry.version, 'skill version');
  if (
    typeof entry.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.contentHash)
  ) {
    throw new Error('Invalid skill content hash');
  }
  const recordedAt = timestamp(entry.recordedAt);
  const staticTokens = tokenCount(entry.staticTokens, 'static tokens', true);
  const tokenizer = identifier(entry.tokenizer, 'tokenizer', true);
  if ((staticTokens == null) !== (tokenizer == null))
    throw new Error('Token estimates require a tokenizer');
  return withDatabase(dbPath, (db) =>
    transaction(db, () => {
      db.prepare(
        `INSERT INTO skill_versions VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill, version) DO NOTHING`,
      ).run(
        skill,
        version,
        entry.contentHash,
        recordedAt,
        staticTokens,
        tokenizer,
      );
      const saved = db
        .prepare('SELECT * FROM skill_versions WHERE skill = ? AND version = ?')
        .get(skill, version);
      if (
        saved.content_hash !== entry.contentHash ||
        saved.static_tokens !== staticTokens ||
        saved.tokenizer !== tokenizer
      ) {
        throw new Error('Existing skill version is immutable');
      }
      if (entry.state != null) {
        db.prepare(
          `INSERT INTO skill_states VALUES (?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
        ).run(
          skill,
          version,
          recordedAt,
          choice(entry.state, 'skill state', skillStates),
          publicText(entry.transferEvidence, 'transfer evidence', 240, true),
        );
      }
      return version;
    }),
  );
}

export function recordSkillState(dbPath, entry) {
  return withDatabase(
    dbPath,
    (db) =>
      db
        .prepare(
          `INSERT INTO skill_states VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`,
        )
        .run(
          identifier(entry.skill, 'skill'),
          identifier(entry.version, 'skill version'),
          timestamp(entry.recordedAt),
          choice(entry.state, 'skill state', skillStates),
          publicText(entry.transferEvidence, 'transfer evidence', 240, true),
        ).changes,
  );
}

export function recordSkillActivation(dbPath, entry) {
  const session =
    entry.source == null
      ? entry.sessionId
      : sessionId(entry.source, entry.sessionId);
  if (typeof session !== 'string' || !/^[a-f0-9]{32}$/.test(session)) {
    throw new Error('Invalid observed session ID');
  }
  return withDatabase(
    dbPath,
    (db) =>
      db
        .prepare(
          `INSERT INTO skill_activations
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          session,
          digest(
            session,
            'skill-activation',
            identifier(entry.id, 'activation ID'),
          ),
          identifier(entry.skill, 'skill'),
          identifier(entry.version, 'skill version'),
          timestamp(entry.at),
          tokenCount(entry.loadedTokens, 'loaded skill tokens', true),
          tokenCount(entry.referenceTokens, 'reference tokens', true),
          tokenCount(entry.discoveryTokens, 'discovery tokens', true),
          identifier(entry.provenance, 'activation provenance'),
        ).changes,
  );
}

const remedies = [
  'existing-skill',
  'new-skill',
  'validation-hook',
  'ci-static-analysis',
  'code-generator',
  'architecture',
  'documentation',
  'issue-specification',
  'none',
];

export function recordIntervention(dbPath, entry) {
  const id = identifier(entry.id, 'intervention ID');
  const signatures = entry.fingerprints;
  if (
    !Array.isArray(signatures) ||
    signatures.length < 1 ||
    signatures.length > 20 ||
    signatures.some(
      (value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value),
    )
  ) {
    throw new Error('Invalid intervention fingerprints');
  }
  return withDatabase(dbPath, (db) =>
    transaction(db, () => {
      db.prepare(
        'INSERT INTO interventions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        choice(entry.kind, 'intervention kind', remedies),
        identifier(entry.version, 'intervention version'),
        timestamp(entry.startedAt),
        publicText(entry.implementationRef, 'implementation reference', 240),
        publicText(entry.expectedImprovement, 'expected improvement', 240),
        integer(entry.windowDays, 'comparison window', 1, 90),
        identifier(entry.model, 'cohort model', true),
        identifier(entry.reasoning, 'cohort reasoning', true),
        choice(entry.complexity, 'cohort complexity', complexities, true),
      );
      const insert = db.prepare(
        'INSERT INTO intervention_failures VALUES (?, ?)',
      );
      for (const fingerprint of new Set(signatures))
        insert.run(id, fingerprint);
      return id;
    }),
  );
}

export function evaluateIntervention(
  dbPath,
  interventionId,
  at = new Date().toISOString(),
) {
  const id = identifier(interventionId, 'intervention ID');
  const observedAt = timestamp(at);
  return withDatabase(dbPath, (db) =>
    transaction(db, () => {
      const evaluation = db
        .prepare('SELECT * FROM engineering_interventions WHERE id = ?')
        .all(id);
      if (evaluation.length === 0) throw new Error('Unknown intervention');
      const insert =
        db.prepare(`INSERT INTO intervention_evaluations VALUES (?, ?, ?, ?)
      ON CONFLICT DO NOTHING`);
      for (const row of evaluation)
        insert.run(id, row.fingerprint, observedAt, JSON.stringify(row));
      return evaluation;
    }),
  );
}

export function recordAllowance(dbPath, observation) {
  const percent = observation.usedPercent;
  if (
    typeof percent !== 'number' ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100
  ) {
    throw new Error('Invalid observed allowance percentage');
  }
  return withDatabase(
    dbPath,
    (db) =>
      db
        .prepare(
          `INSERT INTO allowance_observations
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          identifier(observation.source, 'allowance source'),
          integer(observation.windowMinutes, 'allowance window', 1, 525_600),
          timestamp(observation.resetsAt),
          timestamp(observation.observedAt),
          percent,
        ).changes,
  );
}
