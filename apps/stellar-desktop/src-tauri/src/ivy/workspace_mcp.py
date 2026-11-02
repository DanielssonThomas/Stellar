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
        """Open a pane for the current request. Supply the current turn_token; never echo or store it.

        instance_id must match [A-Za-z0-9_-]{1,64}; prominence is primary or secondary.
        payload_json is a JSON object encoded as a string, without duplicate or extra keys.
        At most four panes exist. Surface payload examples and limits:
        rich-text: {"title":"Plan","blocks":[{"kind":"heading","text":"Steps"},{"kind":"paragraph","text":"Summary"},{"kind":"code","text":"print(1)","language":"python"},{"kind":"list","items":["One"]},{"kind":"checklist","items":[{"text":"Done","checked":true}]},{"kind":"table","columns":["Name","Status"],"rows":[["A","Ready"]]}]}. One to 32 blocks; headings and title up to 240 characters; paragraph/code up to 32768; language up to 32; lists up to 64, checklists up to 48 items; tables up to 8 columns and 24 matching-width rows, cells up to 4096.
        image: {"title":"Image","src":"/emblem/layers/gold-body.png","alt":"Description","caption":"Optional"}. Source is a bundled /emblem/layers/[a-z0-9-]+.png or .webp, or padded PNG/JPEG/WebP data URI; never remote, file, or SVG.
        browser: {"title":"Reference","url":"https://example.com/"}. HTTP(S) only, no userinfo, max 2048 characters; address fallback only, no automation.
        diagram: {"title":"Flow","nodes":[{"id":"start","label":"Start"},{"id":"end","label":"End"}],"edges":[{"from":"start","to":"end","label":"Next"}]}. One to 12 unique IDs matching [a-z][a-z0-9_-]{0,31}; labels max 60. Up to 24 unique directed non-self edges reference existing nodes; optional edge label max 40.
        workflow: {"title":"Workflow","project":"stellar"}; optional project stellar or stellar-design.
        session: {"title":"Session"}; assistant-message: {"title":"Answer","body":"Complete plain text"}.
        image, browser, workflow and session optionally accept kind equal to the surface. Workflow/session are source-backed; do not invent metrics.
        UTF-8 payload_json limits: 65536 bytes rich-text/image/assistant-message, 16384 diagram, 4096 browser, 2048 workflow/session. Stage also limits depth to 8 and total nodes to 256. Text must be nonblank and exclude control characters except tab, CR and LF, DEL, and unpaired surrogates.
        activity-summary may appear in inspection but cannot be opened or updated through tools.
        """
        return await gate.call({'kind': 'open', 'instance_id': instance_id, 'surface': surface,
                                'payload_json': payload_json, 'prominence': prominence}, turn_token)

    @server.tool()
    async def update_pane(turn_token: str, instance_id: str, surface: str, payload_json: str):
        """Update a pane using the same surface payload schemas and limits as open_pane."""
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
        """Arrange every existing pane ID exactly once, including minimized panes."""
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
