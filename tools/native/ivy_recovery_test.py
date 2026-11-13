"""Recovery proof boundary; no installed state, model, mutation or client submission."""
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from tools.native.ivy_bridge_test import bridge, Connection
from stellar_ivy_recovery import recover
from stellar_ivy_recovery_store import inventory
import stellar_ivy_recovery_store as store

DATA = json.loads((Path(__file__).parent / 'evidence/recovery-retained-v1.json').read_text(encoding='utf-8'))


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.profile = Path(temporary.name)
        self.sid = DATA['binding']['owner_session_id']
        self.start = copy.deepcopy(DATA['raw_start']['params'])
        self.notice = self.start['payload']['plugin_notification']
        binding = self.notice['binding']
        binding['profile_id'] = str(self.profile)
        identity = {key:binding[key] for key in ('profile_id','session_id','owner_session_id','session_key','plugin_id','tracking_id')}
        binding['binding_id'] = hashlib.sha256(json.dumps(identity,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        self.receipt = copy.deepcopy(DATA['producer_inspection_rpc']['result']['host']['receipt'])
        self.receipt['ref']['profile_id'] = str(self.profile)
        self.snapshot = copy.deepcopy(DATA['resume_after_restart']['result'])
        self.snapshot['info']['profile_id'] = str(self.profile)
        self.cursor = {key:self.snapshot[key] for key in ('session_id','authority_epoch','execution_generation','revision','replay_epoch','last_sequence')}
        self.cursor['profile_id'] = str(self.profile)
        self.db = sqlite3.connect(self.profile / 'state.db')
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE runtime_epoch(singleton INTEGER,epoch INTEGER);
            CREATE TABLE sessions(id TEXT,runtime_generation INTEGER,runtime_revision INTEGER);
            CREATE TABLE state_meta(key TEXT,value TEXT);
            CREATE TABLE session_admissions(admission_id TEXT,request_id TEXT,principal_id TEXT,target_session_id TEXT,
                seq INTEGER,status TEXT,outcome TEXT,owner_epoch INTEGER,generation INTEGER,payload_json TEXT);''')
        self.db.execute('INSERT INTO runtime_epoch VALUES(1,2)')
        self.db.execute('INSERT INTO sessions VALUES(?,1,1)',(self.sid,))
        key = json.dumps(['plugin-notification',binding['binding_id'],binding['revision'],self.notice['event_id']],separators=(',',':'))
        payload = {'local_automation_v1':{'plugin_notification':self.notice,'display_kind':'internal_notification',
                    'owner':self.sid,'target':self.sid,'route':binding['session_key'],'identity':key}}
        self.db.execute('INSERT INTO session_admissions VALUES(?,?,?,?,?,?,?,?,?,?)',
            (self.receipt['admission_id'],key,'automation:'+binding['session_key'],self.sid,1,'terminal','completed',1,1,json.dumps(payload)))
        self.db.commit()
        self.conn = Connection()
        self.conn.selected_session = self.sid
        self.conn.active = {'session_id':self.sid,'input_id':'old-UNKNOWN'}
        self.calls = []
        async def rpc(method, **params):
            self.calls.append((method,params))
            if method=='session.resume':
                return copy.deepcopy(self.snapshot)
            self.assertEqual(method,'prompt.receipt')
            return copy.deepcopy(self.receipt)
        self.conn.rpc = rpc

    async def recovery(self, **overrides):
        async def replay(_conn, params):
            self.assertEqual(params['replay_epoch'],self.snapshot['replay_epoch'])
            return {'events':[],'truncated':False,'replay_epoch':params['replay_epoch'],'last_sequence':0}
        params={'session_id':self.sid,'after_sequence':0,'retained':[self.receipt['admission_id']],**overrides}
        return await recover(self.conn,params,self.profile,1,replay)

    async def test_complete_snapshot_inventory_and_private_reads_preserve_unknown_and_lease(self):
        result=await self.recovery()
        self.assertEqual(result['entries'][0]['descriptor'],self.notice)
        self.assertEqual(result['entries'][0]['receipt'],self.receipt)
        self.assertEqual(self.conn.active,{'session_id':self.sid,'input_id':'old-UNKNOWN'})
        self.assertEqual(self.conn.completed,set())
        self.assertEqual(self.conn.lease.released,[])
        self.assertEqual([m for m,_ in self.calls],['session.resume','prompt.receipt','session.resume'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM session_admissions').fetchone()[0],1)

    async def test_scope_epoch_generation_and_revision_mismatch_fail_without_writing(self):
        for field,value in [('authority_epoch',999),('execution_generation',2),('revision',999)]:
            changed={**self.cursor,field:value}
            with self.assertRaises(ValueError):
                inventory(self.profile,changed)
        with self.assertRaises(ValueError):
            await self.recovery(session_id='foreign')
        self.db.execute('UPDATE sessions SET runtime_generation=2')
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'unaccounted_generation'):
            inventory(self.profile,{**self.cursor,'execution_generation':2})

    async def test_receipt_conflict_or_selection_change_cannot_commit_a_recovery(self):
        self.receipt['sequence']=77
        with self.assertRaisesRegex(ValueError,'receipt_conflict'):
            await self.recovery()
        self.receipt['sequence']=1
        original=self.conn.rpc
        async def changed(method,**params):
            result=await original(method,**params)
            if method=='prompt.receipt':
                self.conn.selected_session='foreign'
            return result
        self.conn.rpc=changed
        with self.assertRaises(ValueError):
            await self.recovery()
        self.assertEqual(self.conn.lease.released,[])

    async def test_second_epoch_change_or_repeated_tail_gap_is_not_a_valid_snapshot(self):
        original=self.conn.rpc
        async def changed(method,**params):
            result=await original(method,**params)
            if method=='session.resume' and len(self.calls)>1:
                result['replay_epoch']='different-again'
            return result
        self.conn.rpc=changed
        with self.assertRaisesRegex(ValueError,'fence_changed'):
            await self.recovery()
        self.conn.rpc=original
        async def gap(*_):
            return {'truncated':True,'replay_epoch':self.snapshot['replay_epoch']}
        with self.assertRaisesRegex(ValueError,'tail_gap'):
            await recover(self.conn,{'session_id':self.sid,'after_sequence':0,'retained':[]},self.profile,1,gap)

    def test_capacity_and_marked_row_provenance_are_closed(self):
        with patch.object(store,'LIMIT',0), self.assertRaises(ValueError):
            inventory(self.profile,self.cursor)
        self.db.execute("UPDATE session_admissions SET principal_id='forged'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'provenance'):
            inventory(self.profile,self.cursor)

    async def test_lifecycle_protocol_markers_cannot_be_projected_away(self):
        for name,value in [('background_v1',None),('background_delivery_authorized',False)]:
            self.receipt[name]=value
            with self.assertRaisesRegex(ValueError,'lifecycle_receipt'):
                await self.recovery()
            del self.receipt[name]
        self.assertEqual(self.conn.lease.released,[])
        self.assertEqual(self.conn.active['input_id'],'old-UNKNOWN')

    async def test_missing_old_host_inspection_is_unavailable_without_touching_foreground(self):
        from stellar_ivy_notifications import inspect_forward
        import stellar_ivy_controls
        class Unsupported(Exception):
            pass
        async def rpc(*args,**params):
            raise Unsupported('method not supported')
        self.conn.rpc_error_type=Unsupported
        self.conn.rpc=rpc
        with self.assertRaises(stellar_ivy_controls.Refused) as result:
            await inspect_forward(self.conn,{'session_id':self.sid,'admission_id':self.receipt['admission_id'],
                'descriptor':self.notice},str(self.profile),1)
        self.assertEqual(str(result.exception),'unavailable')
        self.assertEqual(self.conn.active['input_id'],'old-UNKNOWN')
        self.assertEqual(self.conn.lease.released,[])

    async def test_actual_gap_reply_is_forwarded_as_gap_instead_of_closing_bridge(self):
        async def rpc(*_args,**_params):
            return DATA['replay_after_restart']['result']
        self.conn.rpc=rpc
        result=await bridge.replay_events(self.conn,{'session_id':self.sid,'replay_epoch':DATA['old_epoch'],'last_sequence':2},None)
        self.assertTrue(result['snapshot_required'] and result['truncated'])
        self.assertNotEqual(result['replay_epoch'],DATA['old_epoch'])


if __name__=='__main__':
    unittest.main()
