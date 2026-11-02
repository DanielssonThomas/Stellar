"""Owned loopback server and durable, credential-referenced ACP descriptor."""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import re
import secrets
import socket

REFERENCE = re.compile(r'^[0-9a-f]{32}$', re.ASCII)


class WorkspaceUnavailable(Exception):
    pass


class WorkspaceService:
    def __init__(self, credentials, gate, make_server):
        self.credentials = credentials
        self.gate = gate
        self.make_server = make_server
        self.socket = None
        self.server = None
        self.task = None
        self.port = None
        self.reference = None
        self.bearer = None
        self.owner_session = None
        self.tokens = []
        self.image_server = None
        self.image_secret = None
        self.image_clients = set()

    async def start(self, descriptor=None):
        import uvicorn
        if self.task is not None:
            raise WorkspaceUnavailable()
        if descriptor is None:
            reference, bearer = self.credentials.create()
            port = 0
        else:
            if (type(descriptor) is not dict or set(descriptor) != {'port', 'credential_ref'} or
                    type(descriptor['port']) is not int or not 1 <= descriptor['port'] <= 65535 or
                    type(descriptor['credential_ref']) is not str or
                    REFERENCE.fullmatch(descriptor['credential_ref']) is None):
                raise WorkspaceUnavailable()
            port = descriptor['port']
            reference = descriptor['credential_ref']
            bearer = self.credentials.read(reference)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            sock.bind(('127.0.0.1', port))
            sock.listen(16)
            selected = sock.getsockname()[1]
            _, app = self.make_server(self.gate, bearer, selected)
            config = uvicorn.Config(app, log_config=None, log_level='critical', access_log=False,
                                    proxy_headers=False, lifespan='on', ws='none')
            server = uvicorn.Server(config)
            task = asyncio.create_task(server.serve(sockets=[sock]))
            self.socket, self.server, self.task = sock, server, task
            for _ in range(500):
                if server.started:
                    self.port, self.reference, self.bearer = selected, reference, bearer
                    self.image_secret = secrets.token_hex(32)
                    self.image_server = await asyncio.start_server(self._image_client, '127.0.0.1', 0,
                                                                   limit=4097, backlog=4)
                    image_port = self.image_server.sockets[0].getsockname()[1]
                    return {'descriptor': {'port': selected, 'credential_ref': reference},
                            'image_port': image_port, 'image_secret': self.image_secret}
                if task.done():
                    await task
                    break
                await asyncio.sleep(.01)
            raise WorkspaceUnavailable()
        except asyncio.CancelledError:
            await self.stop()
            with contextlib.suppress(OSError):
                sock.close()
            raise
        except Exception:
            await self.stop()
            with contextlib.suppress(OSError):
                sock.close()
            raise WorkspaceUnavailable() from None

    def editor(self):
        if self.port is None or self.bearer is None or self.task is None or self.task.done():
            raise WorkspaceUnavailable()
        return {'mcp_servers': [{
            'type': 'http', 'name': 'stellar_workspace',
            'url': f'http://127.0.0.1:{self.port}/mcp',
            'headers': [{'name': 'Authorization', 'value': 'Bearer ' + self.bearer}],
        }], 'edit_approval_policy': 'ask'}

    def bind_session(self, session_id):
        if session_id is not None and (type(session_id) is not str or not 1 <= len(session_id.encode('utf-8')) <= 512):
            raise WorkspaceUnavailable()
        self.owner_session = session_id

    def verifies(self, info):
        if type(info) is not dict or info.get('source') != 'acp' or info.get('edit_approval_policy') != 'ask':
            return False
        launch = info.get('launch_request')
        editor = launch.get('editor') if type(launch) is dict else None
        servers = editor.get('mcp_servers') if type(editor) is dict else None
        fingerprint = servers.get('fingerprint') if type(servers) is dict else None
        expected = hashlib.sha256(json.dumps(self.editor()['mcp_servers'], sort_keys=True,
                                  separators=(',', ':')).encode('utf-8')).hexdigest()
        return (type(fingerprint) is str and fingerprint.isascii() and
                hmac.compare_digest(fingerprint, expected))

    def remember_token(self, token):
        if len(self.tokens) >= 1024:
            raise WorkspaceUnavailable()
        self.tokens.append(token)

    def redact(self, text):
        for token in self.tokens:
            text = text.replace(token, '[redacted]')
        return text

    def wrap_client(self, client):
        service = self

        class ScopedClient:
            def __getattr__(self, name):
                return getattr(client, name)

            async def rpc(self, method, **params):
                if method == 'session.resume' and service.owner_session is not None and params.get('session_id') == service.owner_session:
                    params['editor'] = {'mcp_servers': service.editor()['mcp_servers']}
                return await client.rpc(method, **params)

        return ScopedClient()

    async def _image_client(self, reader, writer):
        task = asyncio.current_task()
        if len(self.image_clients) >= 2:
            writer.close()
            return
        self.image_clients.add(task)
        try:
            peer = writer.get_extra_info('peername')
            if not peer or peer[0] != '127.0.0.1':
                return
            line = await asyncio.wait_for(reader.readline(), 2)
            if len(line) > 4096 or not line.endswith(b'\n'):
                return
            frame = json.loads(line, object_pairs_hook=self._unique,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (type(frame) is not dict or set(frame) != {'secret', 'header', 'size'} or
                    type(frame['secret']) is not str or not frame['secret'].isascii() or
                    self.image_secret is None or not hmac.compare_digest(frame['secret'], self.image_secret) or
                    type(frame['size']) is not int or not 0 < frame['size'] <= 4 * 1024 * 1024):
                return
            image = await asyncio.wait_for(reader.readexactly(frame['size']), 10)
            self.gate.reply_image(frame['header'], image)
            writer.write(b'\x01')
            await asyncio.wait_for(writer.drain(), 2)
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            self.image_clients.discard(task)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    @staticmethod
    def _unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    async def stop(self):
        self.gate.disarm()
        if self.image_server is not None:
            self.image_server.close()
            await self.image_server.wait_closed()
        for client in list(self.image_clients):
            client.cancel()
        if self.image_clients:
            await asyncio.gather(*list(self.image_clients), return_exceptions=True)
        self.image_server = None
        self.image_secret = None
        if self.server is not None:
            self.server.should_exit = True
        if self.task is not None:
            try:
                await asyncio.wait_for(self.task, 5)
            except Exception:
                self.task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self.task
        if self.socket is not None:
            with contextlib.suppress(OSError):
                self.socket.close()
        self.socket = self.server = self.task = None
        self.port = self.reference = self.bearer = None
        self.owner_session = None
