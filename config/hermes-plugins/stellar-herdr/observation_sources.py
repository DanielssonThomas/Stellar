"""Read bounded, structured Herdr and GitHub facts; never worker transcripts."""
from __future__ import annotations

import re
import time
from datetime import datetime

from .core import ADDRESS, ROLES, Unavailable, command

REPOSITORY = 'DanielssonThomas/Stellar'
SHA = re.compile(r'[0-9a-f]{40}')
INCARNATION = re.compile(r'[0-9a-f]{32}')
KINDS = ('worker_exited', 'worker_blocked', 'waiting_review', 'checks_failed',
         'checks_passed', 'merged', 'workflow_verified')
QUERY = '''query StellarWorkerObservation($issue: Int!, $branch: String!) {
  repository(owner: "DanielssonThomas", name: "Stellar") {
    issue(number: $issue) {
      state body labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    }
    pullRequests(headRefName: $branch, first: 100, states: [OPEN, CLOSED, MERGED]) {
      pageInfo { hasNextPage }
      nodes {
        number headRefName headRefOid baseRefName isCrossRepository state isDraft mergedAt
        closingIssuesReferences(first: 100) { nodes { number url } pageInfo { hasNextPage } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } }
          }
        } } } }
      }
    }
  }
}'''


def complete_nodes(connection):
    if (type(connection) is not dict or type(connection.get('pageInfo')) is not dict or
            connection['pageInfo'].get('hasNextPage') is not False or type(connection.get('nodes')) is not list):
        raise Unavailable('GitHub source enumeration is incomplete.')
    return connection['nodes']


def validate_receipt(row):
    if (type(row) is not dict or type(row.get('schema')) is not int or row['schema'] != 1 or row.get('launch') != 'accepted' or
            type(row.get('issue')) is not int or not 1 <= row['issue'] <= 2**31 - 1 or
            row.get('role') not in ROLES):
        raise Unavailable('Tracking requires a versioned, confirmed worker launch receipt.')
    patterns = {'terminal': ADDRESS, 'incarnation': INCARNATION, 'baseline': SHA,
                'claim_session': re.compile(r'[a-zA-Z0-9._:-]{1,128}'),
                'branch': re.compile(r'issue/' + str(row['issue']) + r'-[a-zA-Z0-9._/-]{1,180}'),
                'target': re.compile(r'develop|release/[0-9]{4}\.[0-9]{2}')}
    if any(type(row.get(key)) is not str or not pattern.fullmatch(row[key])
           for key, pattern in patterns.items()):
        raise Unavailable('The launch receipt lacks exact claim and incarnation provenance.')
    return {key: row[key] for key in ('schema', 'launch', 'issue', 'role', *patterns)}


def check_claim(settings, receipt, now):
    claim = command([settings['node'], 'tools/policy/manage-issue-worktree.mjs',
                     'inspect', receipt['issue']], cwd=settings['repo'])
    expected = {'issue': receipt['issue'], 'worker': f"worker:{receipt['role']}",
                'sessionId': receipt['claim_session'], 'branch': receipt['branch'],
                'target': receipt['target']}
    if any(claim.get(key) != value for key, value in expected.items()):
        raise Unavailable('Claim provenance changed; observation is suspended.')
    if claim.get('state') == 'released':
        return
    try:
        expiry = datetime.fromisoformat(claim['expiresAt'].replace('Z', '+00:00'))
        valid = expiry.tzinfo is not None and expiry.timestamp() > now
    except (KeyError, TypeError, ValueError, AttributeError):
        valid = False
    if claim.get('state') != 'active' or not valid:
        raise Unavailable('The exact claim is not active or released; observation is suspended.')


def worker_fact(core, receipt):
    row = core.call('get', receipt['terminal'], '--json')
    labels = row.get('labels')
    expected = {'stellar-delegate': 'ivy', 'issue': str(receipt['issue']),
                'role': receipt['role'], 'stellar-launch': receipt['incarnation']}
    if (type(labels) is not dict or any(labels.get(key) != value for key, value in expected.items()) or
            row.get('state') not in ('live', 'finished')):
        raise Unavailable('Herdr cannot verify this retained worker incarnation.')
    code = row.get('exit_code')
    if row['state'] == 'finished' and type(code) is not int:
        raise Unavailable('Herdr has no verified exit code for this worker.')
    return {'state': row['state'], 'exit_code': code if row['state'] == 'finished' else None,
            'blocked': row.get('status') == 'blocked'}


def github_fact(settings, receipt):
    result = command([settings['gh'], 'api', 'graphql', '-f', f'query={QUERY}',
                      '-F', f"issue={receipt['issue']}", '-f', f"branch={receipt['branch']}"],
                     cwd=settings['repo'], timeout=12)
    try:
        repo = result['data']['repository']
        issue = repo['issue']
        labels = complete_nodes(issue['labels'])
        pulls = complete_nodes(repo['pullRequests'])
    except (KeyError, TypeError):
        raise Unavailable('GitHub source metadata is incomplete.') from None
    if result.get('errors'):
        raise Unavailable('GitHub returned partial source errors.')
    if (issue.get('state') not in ('OPEN', 'CLOSED') or type(issue.get('body')) is not str or type(labels) is not list or
            any(type(label) is not dict or type(label.get('name')) is not str for label in labels)):
        raise Unavailable('GitHub issue metadata is incomplete.')
    labels = {label['name'] for label in labels}
    owners = {label for label in labels if label.startswith(('owner:', 'worker:'))}
    targets = {label for label in labels if label.startswith('target:')}
    if owners != {f"worker:{receipt['role']}"} or targets != {f"target:{receipt['target']}"}:
        raise Unavailable('GitHub ownership or target changed; observation is suspended.')
    statuses = {label for label in labels if label.startswith('status:')}
    if len(statuses) != 1 or not statuses <= {f'status:{state}' for state in
                                            ('triage', 'ready', 'in-progress', 'blocked', 'review', 'done')}:
        raise Unavailable('GitHub workflow status is ambiguous.')
    linked = []
    for pr in pulls:
        if type(pr) is not dict:
            raise Unavailable('GitHub pull request linkage is unavailable.')
        references = complete_nodes(pr.get('closingIssuesReferences'))
        url = f"https://github.com/{REPOSITORY}/issues/{receipt['issue']}"
        if any(type(ref) is dict and ref.get('url') == url for ref in references):
            linked.append(pr)
    if len(linked) > 1:
        raise Unavailable('Multiple linked PRs need explicit reconciliation.')
    if not linked:
        return {'pr': None, 'head': None, 'state': None, 'checks': 'unknown', 'verified': False,
                'waiting_review': False}
    pr = linked[0]
    if (pr.get('headRefName') != receipt['branch'] or pr.get('baseRefName') != receipt['target'] or
            type(pr.get('headRefOid')) is not str or not SHA.fullmatch(pr['headRefOid']) or
            type(pr.get('number')) is not int or pr['number'] < 1 or
            pr.get('state') not in ('OPEN', 'CLOSED', 'MERGED') or pr.get('isCrossRepository') is not False or
            type(pr.get('isDraft')) is not bool or
            (pr['state'] == 'MERGED' and not pr.get('mergedAt'))):
        raise Unavailable('GitHub cannot bind the linked PR to the exact branch, target and head.')
    checks = pr_checks(pr)
    criteria = re.findall(r'^\s*- \[([ xX])\] .+', issue.get('body') or '', re.MULTILINE)
    verified = (issue['state'] == 'CLOSED' and 'status:done' in labels and
                bool(criteria) and all(mark.lower() == 'x' for mark in criteria) and checks == 'passed')
    return {'pr': pr['number'], 'head': pr['headRefOid'], 'state': pr['state'],
            'checks': checks, 'verified': verified and pr['state'] == 'MERGED',
            'waiting_review': pr['state'] == 'OPEN' and not pr['isDraft'] and 'status:review' in labels}


def pr_checks(pr):
    try:
        commits = pr['commits']['nodes']
        if len(commits) != 1 or commits[0]['commit']['oid'] != pr['headRefOid']:
            return 'unknown'
        rollup = commits[0]['commit']['statusCheckRollup']
        return check_state(complete_nodes(rollup['contexts'])) if rollup else 'unknown'
    except (Unavailable, KeyError, TypeError):
        return 'unknown'


def check_state(rows):
    if type(rows) is not list or not rows:
        return 'unknown'
    states = []
    for row in rows:
        if type(row) is not dict:
            return 'unknown'
        if row.get('__typename') == 'CheckRun':
            states.append(row.get('conclusion') if row.get('status') == 'COMPLETED' else 'PENDING')
        elif row.get('__typename') == 'StatusContext':
            states.append(row.get('state'))
        else:
            return 'unknown'
    if any(state in ('FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE') for state in states):
        return 'failed'
    return 'passed' if all(state == 'SUCCESS' for state in states) else 'pending'


def snapshot(settings, core, receipt, *, clock=time.time):
    started = clock()
    check_claim(settings, receipt, started)
    worker = worker_fact(core, receipt)
    github = github_fact(settings, receipt)
    if not 0 <= clock() - started <= 60:
        raise Unavailable('Source observations exceeded the freshness window.')
    return {'worker': worker, 'github': github}


def milestones(facts):
    worker, github = facts['worker'], facts['github']
    result = {}
    if worker['state'] == 'finished':
        result['worker_exited'] = {'exit_code': worker['exit_code']}
    if worker['blocked']:
        result['worker_blocked'] = {}
    pr = {key: github[key] for key in ('pr', 'head')}
    if github['waiting_review']:
        result['waiting_review'] = pr
    if github['checks'] in ('failed', 'passed'):
        result['checks_' + github['checks']] = pr
    if github['state'] == 'MERGED':
        result['merged'] = pr
    if github['verified']:
        result['workflow_verified'] = pr
    return result
