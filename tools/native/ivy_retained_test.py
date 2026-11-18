"""Inert native-client contract tests; no installed gateway or credential access."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2] / 'apps/stellar-desktop/src-tauri/src/ivy'
def load(name):
    spec = importlib.util.spec_from_file_location('stellar_' + name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules['stellar_' + name] = module
    return module
controls = load('ivy_controls')
retained = load('ivy_retained')
service = load('workspace_service')

class Lease:
    record = Path(__file__).with_suffix('.inert-absent')
    def acquire(self): pass
    def release(self): pass

class Workspace:
    task = object()
    owner_session = 'current'
    def editor(self):
        return {'mcp_servers': [{'type':'http', 'name':'stellar_workspace', 'url':'http://127.0.0.1:1/mcp', 'headers':[{'name':'Authorization','value':'inert-own-token'}]}]}
    def verifies(self, info): return info.get('attached') is True
    def bind_session(self, sid): self.owner_session = sid

class Client:
    def __init__(self):
        self.calls = []
        self.info = {'source':'acp', 'profile_id':'fixture', 'model':'gpt-6.1-sol',
                     'edit_approval_policy':'ask', 'enabled_toolsets':['file','mcp-editor_stellar_workspace_1234abcd']}
        self.state = {'session_id':'retained','stored_session_id':'physical','running':False,'pending':[],
                      'open_requests':[], 'revision':4,'execution_generation':2,'info':self.info}
        self.mutations = {}
        self.history = ['user question', 'original answer']
    async def rpc(self, method, **p):
        self.calls.append((method, p))
        if method == 'runtime.describe': return {'capabilities':['acp-session-mcp-v1']}
        if method == 'session.resume':
            if p.get('editor'): self.info['attached'] = True
            state=copy.deepcopy(self.state)
            if p['session_id']=='current': state['session_id']='current'
            return state
        if method == 'session.mutate':
            self.mutations.setdefault(p['request_id'], p)
            if self.mutations[p['request_id']] != p: raise ValueError('identity conflict')
            self.info['attached'] = True
            return {'session_id':'retained','operation':'editor_mcp'}
        raise AssertionError('Unexpected effect ' + method)

class Connection:
    active = None
    selected_session = 'current'
    def __init__(self):
        self.client = Client()
        self.lease = Lease()

def owned_workspace():
    own = service.WorkspaceService(None, None, None)
    own.port = 1
    own.bearer = 'inert-own-token'
    own.task = SimpleNamespace(done=lambda: False)
    own.bind_session('current')
    return own


class NativeBindingClient(Client):
    """Native contract: immutable creation metadata, mutable current selection."""
    def __init__(self):
        super().__init__()
        self.selected = None
        self.info['launch_request'] = {'editor': {'mcp_servers': {'fingerprint': '0' * 64}}}

    async def rpc(self, method, **params):
        offered = (params.get('editor') or {}).get('mcp_servers')
        if method == 'session.resume' and offered:
            # The current owner's attach and target attach use distinct native policies.
            if params['session_id'] == 'retained' and offered != self.selected:
                raise ValueError('acp_mcp_policy_conflict')
        result = await super().rpc(method, **params)
        if method == 'session.mutate' and params['operation'] == 'editor_mcp':
            self.selected = copy.deepcopy(params['payload']['mcp_servers'])
        return result

class RetainedTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_service_confirms_current_native_binding_not_immutable_creation_request(self):
        c, own = Connection(), owned_workspace()
        raw = NativeBindingClient()
        c.client = own.wrap_client(raw)
        prepared = await retained.prepare(c, own, 'retained', 'fixture')
        request = {**prepared, 'request_id': 'one-saved-load'}
        result = await retained.commit(c, own, request, 'fixture')
        self.assertEqual(result['session_id'], 'retained')
        self.assertEqual(raw.info['launch_request']['editor']['mcp_servers']['fingerprint'], '0' * 64)
        await retained.commit(c, own, request, 'fixture')
        self.assertEqual(len(raw.mutations), 1)
        self.assertEqual(raw.history, ['user question', 'original answer'])
        resumed = await c.client.rpc('session.resume', session_id='retained')
        self.assertTrue(own.verifies(resumed['info']))
        self.assertFalse(own.verifies(copy.deepcopy(resumed['info'])))

    async def test_real_service_does_not_confirm_missing_rejected_foreign_or_stale_attach(self):
        own, raw = owned_workspace(), NativeBindingClient()
        wrapped = own.wrap_client(raw)
        unoffered = await wrapped.rpc('session.resume', session_id='retained')
        self.assertFalse(own.verifies(unoffered['info']))
        own.bind_session('retained')
        with self.assertRaises(ValueError):
            await wrapped.rpc('session.resume', session_id='retained')
        self.assertFalse(own.verifies(unoffered['info']))
        raw.selected = own.editor()['mcp_servers']
        accepted = await wrapped.rpc('session.resume', session_id='retained')
        self.assertTrue(own.verifies(accepted['info']))
        own.port = 2
        self.assertFalse(own.verifies(accepted['info']))
        own.port = 1
        await wrapped.rpc('session.resume', session_id='other')
        self.assertFalse(own.verifies(accepted['info']))

    async def test_confirmation_requires_exact_owned_offer_and_native_session_identity(self):
        own = owned_workspace()
        info = {'source':'acp', 'edit_approval_policy':'ask'}
        class Peer:
            async def rpc(self, method, **params):
                return {'session_id':'wrong', 'info':info}
        wrapped = own.wrap_client(Peer())
        await wrapped.rpc('session.resume', session_id='target', editor=own.editor())
        self.assertFalse(own.verifies(info))
        await wrapped.rpc('session.create', editor={'mcp_servers':[]})
        self.assertFalse(own.verifies(info))
        await wrapped.rpc('session.create', editor=own.editor())
        self.assertTrue(own.verifies(info))
        await wrapped.rpc('session.mutate', session_id='wrong', operation='editor_mcp')
        self.assertFalse(own.verifies(info))
    async def test_existing_current_session_reconnect_resupplies_only_its_own_transport(self):
        own=service.WorkspaceService(None,None,None)
        own.port=1;own.bearer='inert-own-token';own.task=SimpleNamespace(done=lambda:False)
        own.bind_session('retained')
        raw=Client();wrapped=own.wrap_client(raw)
        await wrapped.rpc('session.resume',session_id='retained')
        self.assertEqual(raw.calls[-1][1]['editor'],{'mcp_servers':own.editor()['mcp_servers']})
        await wrapped.rpc('session.resume',session_id='other')
        self.assertNotIn('editor',raw.calls[-1][1])
    async def test_restart_restores_actual_own_transport_without_new_conversation_or_policy_change(self):
        c, w = Connection(), Workspace()
        prepared = await retained.prepare(c, w, 'retained', 'fixture')
        request = {**prepared, 'request_id':'load-once'}
        first = await retained.commit(c, w, request, 'fixture')
        self.assertEqual((first['session_id'], first['stored_session_id'], first['model']), ('retained','physical','gpt-6.1-sol'))
        # A lost reply is checked with the same immutable native operation, never a new grant/effect.
        await retained.commit(c, w, request, 'fixture')
        self.assertEqual(len(c.client.mutations), 1)
        self.assertEqual(c.client.history, ['user question', 'original answer'])
        self.assertEqual(w.owner_session, 'retained')
        mutation = next(iter(c.client.mutations.values()))
        self.assertEqual(mutation['operation'], 'editor_mcp')
        self.assertEqual(mutation['payload'], {'mcp_servers':w.editor()['mcp_servers']})
        self.assertEqual(mutation['expected_revision'], 4)
        self.assertEqual(mutation['expected_generation'], 2)
        self.assertTrue(any(p.get('editor') == {'mcp_servers':w.editor()['mcp_servers']} for m,p in c.client.calls if m=='session.resume'))
        self.assertFalse(any(m in {'prompt.submit','session.create','approval.respond','reload.mcp'} for m,p in c.client.calls))

    async def test_busy_approval_unknown_or_foreign_target_is_refused_before_mutation(self):
        changes = [('running',True),('pending',[{}]),('open_requests',[{}]),('stored_session_id',None)]
        for key,value in changes:
            c,w=Connection(),Workspace();c.client.state[key]=value
            with self.subTest(key=key), self.assertRaises(controls.Refused):
                await retained.prepare(c,w,'retained','fixture')
            self.assertFalse(c.client.mutations)
            self.assertEqual(w.owner_session,'current')
        for key,value in [('source','cli'),('profile_id','other'),('model','unknown'),('enabled_toolsets',['file','mcp-editor_other_1234abcd'])]:
            c,w=Connection(),Workspace();c.client.info[key]=value
            with self.subTest(key=key), self.assertRaises(controls.Refused):
                await retained.prepare(c,w,'retained','fixture')
            self.assertFalse(c.client.mutations)

    async def test_mismatched_physical_model_or_policy_readback_does_not_bind_new_selection(self):
        for key,value in [('stored_session_id','different'),('model','gpt-6.1-terra'),('edit_approval_policy','session')]:
            c,w=Connection(),Workspace();p=await retained.prepare(c,w,'retained','fixture')
            if key=='stored_session_id':c.client.state[key]=value
            else:c.client.info[key]=value
            with self.subTest(key=key), self.assertRaises(controls.Refused):
                await retained.commit(c,w,{**p,'request_id':'fixed'},'fixture')
            self.assertEqual(w.owner_session,'current')

    async def test_unknown_native_result_is_not_retried_and_preserves_selection(self):
        c,w=Connection(),Workspace();p=await retained.prepare(c,w,'retained','fixture')
        original=c.client.rpc
        async def fail(method,**params):
            if method=='session.mutate': raise TimeoutError('private details')
            return await original(method,**params)
        c.client.rpc=fail
        with self.assertRaises(TimeoutError):
            await retained.commit(c,w,{**p,'request_id':'fixed'},'fixture')
        self.assertEqual(w.owner_session,'current')

    async def test_native_skipped_discovery_with_matching_fingerprint_cannot_report_success(self):
        c,w=Connection(),Workspace();p=await retained.prepare(c,w,'retained','fixture')
        original=c.client.rpc
        async def skip(method,**params):
            value=await original(method,**params)
            if method=='session.mutate':
                # Native preserves supplied fingerprint even when server discovery produced no tools.
                c.client.info['enabled_toolsets']=['file']
                value['mcp_servers']=[]
            return value
        c.client.rpc=skip
        with self.assertRaises(controls.Refused) as failure:
            await retained.commit(c,w,{**p,'request_id':'discovery-once'},'fixture')
        self.assertEqual(failure.exception.code,'uncertain')
        self.assertEqual(w.owner_session,'current')
        self.assertEqual(len(c.client.mutations),1)

if __name__=='__main__': unittest.main()
