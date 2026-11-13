"""Replay captured candidate source through the real consumer projection, offline."""
import asyncio
import copy
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tools.native.ivy_bridge_test import bridge, Connection, Pipe


async def main():
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    if data.get('fixture') is not True or data.get('inference') != 'fake; no provider call':
        raise ValueError('Expected exact disconnected producer capture')
    conn, output = Connection(), Pipe()
    conn.selected_session = data['binding']['owner_session_id']
    for key in ['raw_start', 'raw_terminal', 'raw_revoke']:
        await conn.events.put(copy.deepcopy(data[key]))
    await conn.events.put(RuntimeError('end fixture'))
    with patch.object(bridge, 'PROFILE', data['binding']['profile_id']), patch.object(sys, 'stdout', output):
        try:
            await bridge.pump(conn)
        except bridge.Closed:
            pass
    frames = [json.loads(row) for row in output.buffer.getvalue().splitlines()]
    if len(frames) != 3 or conn.completed or conn.lease.released:
        raise ValueError('Projection changed foreground custody')
    data['consumer_frames'] = frames
    Path(sys.argv[2]).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


asyncio.run(main())
