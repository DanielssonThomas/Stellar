INSERT INTO issues VALUES (342, 'medium'), (343, 'small'), (344, 'small');
INSERT INTO budget_revisions VALUES
  (342, 1, '2026-11-01T09:00:00.000Z', 1200, 1300, 'Codex and Ivy', 'low', NULL),
  (342, 2, '2026-11-02T09:00:00.000Z', 1400, 1500, 'Codex and Ivy', 'medium', NULL),
  (343, 1, '2026-11-01T09:00:00.000Z', 900, 1100, 'Codex', 'high', NULL),
  (344, 1, '2026-11-04T09:00:00.000Z', 700, 800, 'Codex', 'medium', NULL);
INSERT INTO sessions VALUES
  ('codex:fixture-342', 'codex', 'codex', 342, NULL, 'model-a', 'openai', 'high',
    '2026-11-02T10:00:00.000Z', '2026-11-02T11:00:00.000Z', '2026-11-02T11:00:00.000Z', 'completed'),
  ('hermes:fixture-342', 'hermes', 'ivy', 342, NULL, 'model-c', 'local', NULL,
    '2026-11-02T12:00:00.000Z', '2026-11-02T12:15:00.000Z', '2026-11-02T12:15:00.000Z', 'completed'),
  ('codex:fixture-review', 'codex', 'reviewer', 342, 'codex:fixture-342', 'model-a', 'openai', 'low',
    '2026-11-03T10:00:00.000Z', NULL, '2026-11-03T10:05:00.000Z', 'active'),
  ('codex:fixture-343', 'codex', 'codex', 343, NULL, 'model-a', 'openai', 'high',
    '2026-11-04T10:00:00.000Z', '2026-11-04T10:15:00.000Z', '2026-11-04T10:15:00.000Z', 'completed');
INSERT INTO usage_streams VALUES
  ('codex:fixture-342', 'a', 'delta', 'model-a', 'openai', 'fixture'),
  ('codex:fixture-342', 'b', 'delta', 'model-b', 'openai', 'fixture'),
  ('hermes:fixture-342', 'a', 'cumulative', 'model-c', 'local', 'fixture'),
  ('codex:fixture-review', 'a', 'cumulative', 'model-a', 'openai', 'fixture'),
  ('codex:fixture-343', 'a', 'delta', 'model-a', 'openai', 'fixture');
INSERT INTO usage_observations VALUES
  ('codex:fixture-342', 'a', '1', '2026-11-02T11:00:00.000Z', 850, 150, 100, NULL, 50, 1000, 1),
  ('codex:fixture-342', 'b', '1', '2026-11-02T11:00:00.000Z', 320, 80, 40, NULL, 20, 400, 1),
  ('hermes:fixture-342', 'a', '1', '2026-11-02T12:15:00.000Z', 230, 90, NULL, NULL, NULL, 320, 1),
  ('codex:fixture-review', 'a', '1', '2026-11-03T10:05:00.000Z', 65, 15, 0, NULL, 5, 80, 0),
  ('codex:fixture-343', 'a', '1', '2026-11-04T10:15:00.000Z', 780, 110, 50, NULL, 20, 890, 1);
INSERT INTO failures VALUES ('rust-fixture-e0308', 'rust', 'E0308', 'Mismatched types');
INSERT INTO attempts VALUES
  ('codex:fixture-342', '1', NULL, '2026-11-02T10:15:00.000Z', 'build', 'rust', 'desktop', 'rust-build', 101, 0, 'rust-fixture-e0308', 'fixture'),
  ('codex:fixture-342', '2', NULL, '2026-11-02T10:20:00.000Z', 'build', 'rust', 'desktop', 'rust-build', 101, 0, 'rust-fixture-e0308', 'fixture'),
  ('codex:fixture-342', '3', NULL, '2026-11-02T10:25:00.000Z', 'build', 'rust', 'desktop', 'rust-build', 0, 0, NULL, 'fixture'),
  ('hermes:fixture-342', '1', NULL, '2026-11-02T12:01:00.000Z', 'test', 'rust', 'desktop', 'compile-fixture', 101, 1, 'rust-fixture-e0308', 'fixture'),
  ('codex:fixture-343', '1', NULL, '2026-11-04T10:02:00.000Z', 'build', 'rust', 'desktop', 'rust-build', 101, 0, 'rust-fixture-e0308', 'fixture');
INSERT INTO skill_versions VALUES
  ('rust-build', '1', 'hash-1', '2026-11-01T09:00:00.000Z', 200, 'fixture tokenizer'),
  ('rust-build', '2', 'hash-2', '2026-11-03T09:00:00.000Z', 140, 'fixture tokenizer');
INSERT INTO skill_states VALUES
  ('rust-build', '1', '2026-11-01T09:00:00.000Z', 'retired', NULL),
  ('rust-build', '2', '2026-11-03T09:00:00.000Z', 'maintained', 'One fixture scenario');
INSERT INTO skill_activations VALUES
  ('codex:fixture-343', '1', 'rust-build', '2', '2026-11-04T10:01:00.000Z', 140, NULL, NULL, 'fixture');
INSERT INTO interventions VALUES
  ('diagnose-rust-build', 'validation-hook', '1', '2026-11-05T09:00:00.000Z', 'fixture revision',
    'Reduce repeated compiler failures', 14, 'model-a', 'high', NULL);
INSERT INTO intervention_failures VALUES ('diagnose-rust-build', 'rust-fixture-e0308');
