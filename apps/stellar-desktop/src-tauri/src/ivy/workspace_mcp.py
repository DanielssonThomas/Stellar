"""Fixed loopback MCP surface; no renderer-provided server or executable options."""
from __future__ import annotations

import base64
import hmac

MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_HTTP_BODY = 524288


class GuardedApp:
    def __init__(self, app, bearer, port):
        if type(bearer) is not str or len(bearer) < 32 or not bearer.isascii():
            raise ValueError('invalid bearer')
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('invalid port')
        self.app = app
        self.authorization = ('Bearer ' + bearer).encode('ascii')
        self.host = f'127.0.0.1:{port}'.encode('ascii')
        self.origin = b'http://' + self.host

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope.get('headers', []):
            key = key.lower()
            if key in headers:
                return await self._reject(send)
            headers[key] = value
        authorization = headers.get(b'authorization', b'')
        origin = headers.get(b'origin')
        length = headers.get(b'content-length')
        if (scope.get('path') != '/mcp' or scope.get('query_string') or
                scope.get('method') not in ('GET', 'POST', 'DELETE') or
                not hmac.compare_digest(headers.get(b'host', b''), self.host) or
                not hmac.compare_digest(authorization, self.authorization) or
                (origin is not None and not hmac.compare_digest(origin, self.origin)) or
                (length is not None and (not length.isdigit() or int(length) > MAX_HTTP_BODY))):
            return await self._reject(send)
        return await self.app(scope, receive, send)

    @staticmethod
    async def _reject(send):
        await send({'type': 'http.response.start', 'status': 403,
                    'headers': [(b'content-type', b'text/plain'), (b'cache-control', b'no-store')]})
        await send({'type': 'http.response.body', 'body': b'Forbidden'})


def make_server(gate, bearer, port):
    from mcp.server import MCPServer
    from mcp.types import ImageContent
    server = MCPServer(name='stellar_workspace', instructions=(
        'Use workspace tools only for the current user request. Supply the current '
        'turn_token supplied in the turn instruction; never invent or reuse it.'))

    @server.tool()
    async def open_pane(turn_token: str, instance_id: str, surface: str,
                        payload_json: str, prominence: str):
        """Open a registered workspace pane."""
        return await gate.call({'kind': 'open', 'instance_id': instance_id, 'surface': surface,
                                'payload_json': payload_json, 'prominence': prominence}, turn_token)

    @server.tool()
    async def update_pane(turn_token: str, instance_id: str, surface: str, payload_json: str):
        """Update a registered pane with its validated payload."""
        return await gate.call({'kind': 'update', 'instance_id': instance_id, 'surface': surface,
                                'payload_json': payload_json}, turn_token)

    @server.tool()
    async def remove_pane(turn_token: str, instance_id: str):
        """Remove one workspace pane."""
        return await gate.call({'kind': 'remove', 'instance_id': instance_id}, turn_token)

    @server.tool()
    async def focus_pane(turn_token: str, instance_id: str):
        """Focus one workspace pane."""
        return await gate.call({'kind': 'focus', 'instance_id': instance_id}, turn_token)

    @server.tool()
    async def arrange_panes(turn_token: str, instance_ids: list[str]):
        """Arrange all visible workspace panes in the requested order."""
        return await gate.call({'kind': 'arrange', 'instance_ids': instance_ids}, turn_token)

    @server.tool()
    async def clear_panes(turn_token: str):
        """Clear the visible workspace."""
        return await gate.call({'kind': 'clear'}, turn_token)

    @server.tool()
    async def inspect_panes(turn_token: str):
        """Read pane identifiers, surfaces, prominence and minimized state only."""
        return await gate.call({'kind': 'inspect'}, turn_token)

    @server.tool(structured_output=False)
    async def capture_window(turn_token: str):
        """Capture the Stellar application window only, when explicitly requested."""
        image = await gate.call({'kind': 'capture_window'}, turn_token)
        if (type(image) is not bytes or not image.startswith(b'\x89PNG\r\n\x1a\n') or
                len(image) > MAX_IMAGE_BYTES):
            raise ValueError('Window capture unavailable')
        return ImageContent(type='image', data=base64.b64encode(image).decode('ascii'), mimeType='image/png')

    app = server.streamable_http_app(streamable_http_path='/mcp', json_response=True, stateless_http=True,
                                     max_request_body_size=MAX_HTTP_BODY, max_sessions=4,
                                     host='127.0.0.1')
    return server, GuardedApp(app, bearer, port)
