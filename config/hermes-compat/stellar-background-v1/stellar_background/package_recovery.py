"""Explicit reconciliation of adjacent filesystem-journal / canonical DB phase writes.

Only known image/phase pairs reconcile; no grant, model, prompt, receipt or custody is replayed.
"""
from .contract import ContractError
from .lifecycle import disable
from .package_io import exclusive


def recover(package, db):
    from .package import fence_payload, payload
    with exclusive(package.root):
        package._refresh()
        package._db(db)
        with db._read_ctx() as conn:
            row = conn.execute('SELECT phase,package_digest FROM stellar_bg_installation_v1 WHERE singleton=1').fetchone()
        if row is None or row[1] != package.state['packageDigest']:
            raise ContractError('database_package_mismatch')
        pair = package.state['phase'], row[0]
        if pair in (('prepared', 'installing'), ('removed', 'installing')):
            package._quiet(db); package._sources('mixed'); package._package(payload(), partial=True)
            package._phase('installing')
            return {'phase': 'installing', 'resumeRequired': True, 'installedCapability': False}
        if pair == ('installing', 'active_candidate'):
            package._quiet(db); package._sources('post'); package._package(payload())
            package._phase('installed')
        elif pair in (('installed', 'disabled'), ('disabling', 'disabled'),
                      ('disabling', 'active_candidate'), ('disabling', 'disabling')):
            package._sources('post'); package._package(payload())
            db._execute_write(disable)
            package._phase('disabled')
        elif pair == ('disabled', 'removing'):
            package._quiet(db); package._sources('post'); package._package(payload())
            package._phase('removing')
            return {'phase': 'removing', 'resumeRequired': True, 'installedCapability': False}
        elif pair == ('installing', 'rolling_back'):
            package._quiet(db); package._sources('mixed'); package._package(payload(), partial=True)
            package._phase('rolling_back')
            return {'phase': 'rolling_back', 'resumeRequired': True, 'installedCapability': False}
        elif pair in (('removing', 'removed'), ('rolling_back', 'removed')):
            package._quiet(db); package._sources('base'); package._package({})
            package._phase('removed')
        elif pair == ('removing', 'fenced'):
            package._quiet(db); package._sources('post'); package._package(fence_payload())
            package._phase('fenced')
        else:
            raise ContractError('recovery_phase_refused')
        return package.verify(db)
