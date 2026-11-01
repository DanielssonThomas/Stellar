# Desktop adapter

The governed shared Angular service library exports DesktopAdapterService and its testable DesktopAdapter core. Consumers call appInfo and subscribe through this public entry point; presentational components do not invoke native commands. DESKTOP_TRANSPORT selects the fixed Tauri bridge in native windows and a browser fake without native capabilities otherwise. Tests can override that injection token.

Requests, replies, errors and events use @stellar/desktop-contracts generated types and strict runtime decoders. Event subscriptions return an idempotent stop function; disposing the adapter rejects new/in-flight operations, ignores queued notifications and releases registrations that complete late. Angular injector destruction disposes the service automatically. Unknown native failures become a fixed transport error without copying native messages or paths.

See the [desktop development guide](https://github.com/DanielssonThomas/Stellar/blob/develop/docs/guides/desktop-development.md) for the contract extension and native verification workflow.
