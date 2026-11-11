"""Project engineering summaries onto the existing Stellar spatial Stage."""
import json

TITLE = 'Engineering Intelligence'
UNAVAILABLE = 'Unavailable'
PANELS = {
    'budget': ('Development Budget', 'Usage and estimates'),
    'sessions': ('Session Intelligence', 'Development history'),
    'patterns': ('Engineering Patterns', 'Recurring failures'),
    'skills': ('Skill Intelligence', 'Instruction overhead'),
}


def display(value):
    if type(value) is int:
        return f'{value:,}'
    if isinstance(value, str):
        return value.strip().encode('utf-8')[:96].decode('utf-8', errors='ignore') or UNAVAILABLE
    return UNAVAILABLE


def paragraph(text):
    return {'kind': 'paragraph', 'text': text}


def table(title, result, columns, project):
    source = result['rows']
    blocks = [{'kind': 'heading', 'text': title}]
    if not source:
        return blocks + [paragraph('No records in this scope.')]
    blocks.append({'kind': 'table', 'columns': columns,
                   'rows': [[display(value) for value in project(row)] for row in source]})
    if result['more']:
        blocks.append(paragraph('Showing a limited result. Ask Ivy to narrow the scope.'))
    return blocks


def complete_usage(tokens, complete, total):
    if tokens is None:
        return UNAVAILABLE
    value = display(tokens)
    return value if complete == total and total else f'{value} (partial)'


def issue_label(number):
    return f'#{number}' if number is not None else 'Unlinked'


def model_label(row):
    return f'{display(row["agent"])} / {display(row["model"])}'


def budget_chart(issues):
    pairs = [row for row in issues if row['session_count'] and row['complete_sessions'] == row['session_count']
             and all(type(row[key]) is int and 0 <= row[key] <= 10**12
                     for key in ('estimated_tokens', 'observed_tokens'))]
    if not pairs:
        return []
    return [{'kind': 'chart', 'chart': {'type': 'bar', 'labels': [issue_label(row['issue_number']) for row in pairs],
            'datasets': [{'label': label, 'values': [row[key] for row in pairs]}
                         for label, key in [('Latest estimate', 'estimated_tokens'), ('Observed', 'observed_tokens')]],
            'y_label': 'Tokens'}}]


def model_usage(title, result):
    return table(title, result, ['Agent / model', 'Provider', 'Observed', 'Cached', 'Uncached'],
                 lambda row: (model_label(row), row['provider'],
                              complete_usage(row['observed_tokens'], row['complete_sessions'], row['session_count']),
                              row['cached_tokens'], row['uncached_tokens']))


def budget_blocks(report):
    def issue(row):
        budget = {1: 'Over', 0: 'Within'}.get(row['over_budget'], UNAVAILABLE)
        observed = complete_usage(row['observed_tokens'], row['complete_sessions'], row['session_count'])
        initial, latest = row['baseline_tokens'], row['estimated_tokens']
        estimate = comparison(initial, latest) if initial is not None and initial != latest else latest
        return (issue_label(row['issue_number']), estimate, row['allocated_tokens'], observed,
                row['baseline_variance_tokens'], budget)

    blocks = (budget_chart(report['issues']['rows']) +
              table('Issue budgets', report['issues'], ['Issue', 'Estimate (initial → latest)', 'Allocated',
                    'Observed', 'Initial variance', 'Budget'], issue))
    if 'revisions' in report:
        blocks += table('Budget revisions', report['revisions'], ['Revision', 'Recorded (UTC)', 'Estimate', 'Allocated',
                        'Execution profile', 'Confidence'], lambda row: (row['revision'], row['recorded_at'],
                        row['estimated_tokens'], row['allocated_tokens'], row['profile'], row['confidence']))
    if 'usage_window' in report:
        blocks.append(paragraph(report['usage_window']))
    blocks += model_usage('Observed usage by agent and model', report['usage_by_model'])
    blocks += model_usage('Ivy reported usage', report['ivy_reported_usage'])
    allowance = report['subscription_allowance']
    if allowance['rows']:
        blocks += table('Observed subscription windows', allowance, ['Source', 'Window (minutes)', 'Used',
                        'Observed (UTC)', 'Resets (UTC)'], lambda row: (row['source'], row['window_minutes'],
                        f'{row["used_percent"]:g}%' if row['used_percent'] is not None else None,
                        row['observed_at'], row['resets_at']))
    else:
        blocks.append(paragraph('Subscription allowance is unavailable.'))
    blocks.append(paragraph('API-equivalent cost and estimated allowance impact are unavailable. '
                            'Issue totals describe recorded sessions. Variance requires complete observed usage for those sessions.'))
    return blocks


def failure_table(result):
    return table('Failure events', result, ['Time (UTC)', 'Issue', 'Signature', 'Description', 'Evidence', 'Retry', 'Resolution'],
                 lambda row: (row['at'], issue_label(row['issue_number']), row['fingerprint'], row['description'],
                              {0: 'Execution', 1: 'Intentional diagnostic'}.get(row['diagnostic']),
                              {0: 'First observed', 1: 'Repeated'}.get(row['retry']),
                              {0: 'Unobserved', 1: 'Pass observed'}.get(row['resolved'])))


def session_blocks(report):
    def session(row):
        observed = complete_usage(row['observed_tokens'], row['usage_complete'], 1)
        return (row['id'], issue_label(row['issue_number']), model_label(row), row['status'], row['started_at'],
                observed, row['attempts'], row['failures'])

    blocks = table('Recorded sessions', report['history'], ['Session', 'Issue', 'Agent / model', 'Status',
                   'Started (UTC)', 'Observed tokens', 'Attempts', 'Failures'], session)
    if 'failure_events' in report:
        blocks += table('Session measurements', report['history'], ['Input', 'Output', 'Cached', 'Uncached',
                        'Provider', 'Reasoning', 'Ended (UTC)', 'Diagnostic failures'],
                        lambda row: (row['input_tokens'], row['output_tokens'], row['cached_tokens'],
                                     row['uncached_tokens'], row['provider'], row['reasoning'], row['ended_at'],
                                     row['diagnostic_failures']))
        blocks += failure_table(report['failure_events'])
        blocks += table('Recorded attempts', report['attempts'], ['Time (UTC)', 'Category', 'Technology', 'Component',
                        'Exit status', 'Diagnostic', 'Signature', 'Source'], lambda row: (row['at'], row['category'],
                        row['technology'], row['component'], row['exit_code'], {0: 'No', 1: 'Yes'}.get(row['diagnostic']),
                        row['fingerprint'], row['provenance']))
    return blocks


def comparison(before, after):
    return f'{display(before)} → {display(after)}'


def intervention_blocks(result):
    def rate(count, attempts):
        return f'{count / attempts:.1%}' if count is not None and attempts else UNAVAILABLE

    def intervention(row):
        before = rate(row['before_failures'], row['before_attempts'])
        after = rate(row['after_failures'], row['after_attempts'])
        return (row['kind'], row['fingerprint'], row['evidence_status'], comparison(before, after),
                comparison(row['before_attempts'], row['after_attempts']),
                comparison(row['before_retries'], row['after_retries']), row['implementation_ref'],
                row['expected_improvement'])

    return table('Interventions and evaluations', result, ['Intervention', 'Signature', 'Evidence', 'Failure rate',
                 'Attempts', 'Retries', 'Implementation', 'Expected improvement'], intervention)


def pattern_blocks(report):
    def pattern(row):
        return (row['fingerprint'], row['code'] or row['description'], row['component'], row['failure_count'],
                row['affected_issues'], row['affected_sessions'], row['retries'], row['associated_observed_tokens'])

    blocks = table('Observed patterns', report['recurring'], ['Signature', 'Diagnostic', 'Component', 'Failures',
                   'Issues', 'Sessions', 'Retries', 'Associated tokens'], pattern)
    blocks.append(paragraph('Associated tokens are the observed totals from affected sessions. '
                            'A session can contribute to several patterns.'))
    if 'failure_events' in report:
        blocks += failure_table(report['failure_events'])
    if 'candidates' in report:
        blocks += table('Investigation candidates', report['candidates'], ['Signature', 'Diagnostic', 'Occurrences',
                        'Issues', 'Suggested starting point'], lambda row: (row['fingerprint'], row['code'],
                        row['occurrences'], row['issues'], row['investigation_start']))
    if 'interventions' in report:
        blocks += intervention_blocks(report['interventions'])
    return blocks


def skill_blocks(report):
    def version(row):
        estimate = f'{display(row["static_tokens"])} ({display(row["tokenizer"])})' if row['static_tokens'] is not None else None
        return (row['skill'], row['version'], row['state'], estimate, row['activations'], row['loaded_tokens'],
                row['reference_tokens'], row['discovery_tokens'])

    def evidence(row):
        return (row['skill'], row['version'], row['failures'], row['retries'], row['transfer_evidence'])

    blocks = (table('Skill versions and context', report['versions'], ['Skill', 'Version', 'State', 'Static estimate',
                    'Activations', 'Loaded', 'References', 'Discovery'], version) +
              table('Effectiveness evidence', report['versions'], ['Skill', 'Version', 'Failures', 'Retries', 'Transfer evidence'],
                    evidence))
    if report['identical_content']['rows']:
        blocks += table('Consolidation candidates with identical instructions', report['identical_content'],
                        ['Skill', 'Version', 'Matching skill', 'Version'],
                        lambda row: (row['skill'], row['version'], row['matching_skill'], row['matching_version']))
    return blocks


BUILD = {'budget': budget_blocks, 'sessions': session_blocks, 'patterns': pattern_blocks, 'skills': skill_blocks}
SUMMARY = {
    'budget': ('issues', 'issue budget'),
    'sessions': ('history', 'recorded session'),
    'patterns': ('recurring', 'failure signature'),
    'skills': ('versions', 'skill version'),
}


def panel_summary(view, data, filters):
    section, label = SUMMARY[view]
    scope = filters.get('issue_number')
    if view == 'budget' and scope and data[section]['rows']:
        row = data[section]['rows'][0]
        usage = complete_usage(row['observed_tokens'], row['complete_sessions'], row['session_count'])
        return f'Issue #{scope} observed tokens · {usage}'
    count = len(data[section]['rows'])
    text = f'{count} {label}{"s" if count != 1 else ""} shown' if count else 'No matching records'
    if scope:
        text += f' for issue #{scope}'
    return text + '.'


def spatial_score(report):
    view = report['view']
    panels = PANELS if view == 'overview' else (view,)
    available = report['state'] == 'available'
    actions = []
    issue = report['filters'].get('issue_number')
    for key in panels:
        title, category = PANELS[key]
        blocks = (BUILD[key](report['data'][key]) if available else
                  [paragraph('Engineering history is unavailable. Check local collection and schema compatibility.')])
        summary = panel_summary(key, report['data'][key], report['filters']) if available else 'Engineering history unavailable.'
        panel = {'id': f'engineering-{key}', 'title': title, 'category': category,
                 'summary': summary,
                 'detail': {'surface': 'rich-text', 'payload': {'title': title, 'blocks': blocks}}}
        if issue:
            panel['source'] = f'https://github.com/DanielssonThomas/Stellar/issues/{issue}'
        actions.append({'kind': 'show', 'panel': panel})
    if view != 'overview':
        actions += [{'kind': 'focus', 'id': f'engineering-{view}'}, {'kind': 'expand', 'id': f'engineering-{view}'}]
    return {'begin': {'title': TITLE, 'label': 'Local history',
                      'description': 'Development budgets, recorded sessions, failure patterns, and skill evidence.'},
            'prepare': actions}


def score_json(report):
    return json.dumps(spatial_score(report), ensure_ascii=False, separators=(',', ':'))
