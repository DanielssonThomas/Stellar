# Desktop contracts

Rust owns the versioned native readiness and app-info request/reply/error/event contracts in `apps/stellar-desktop/src-tauri/src/contracts.rs`. This shared model library exports generated types, typed command/event maps and strict runtime decoders. Canonical decimal strings preserve u64 precision, optional labels normalize null/omission, and required nullable build revisions retain explicit null. Its tags are `scope:shared` and `type:model`.

Run `node tools/native/cargo.mjs contract-generate` after changing the Rust contract, then `pnpm exec nx run stellar-desktop:contract-check`. Do not edit `src/generated.ts`. Generation requires neither an application window nor hardware. Rust serialization fixtures and decoder tests enforce version and representation compatibility. See the [desktop development guide](https://github.com/DanielssonThomas/Stellar/blob/develop/docs/guides/desktop-development.md).
