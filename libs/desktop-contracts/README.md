# Desktop contracts

Rust owns the versioned native readiness request, reply and typed error in `apps/stellar-desktop/src-tauri/src/contracts.rs`. This shared model library exports generated types and a strict runtime reply decoder. Its tags are `scope:shared` and `type:util`.

Run `node tools/native/cargo.mjs contract-generate` after changing the Rust contract, then `pnpm exec nx run stellar-desktop:contract-check`. Do not edit `src/generated.ts`. Generation requires neither an application window nor hardware. Rust serialization fixtures and decoder tests enforce version and representation compatibility. See the [desktop development guide](https://github.com/DanielssonThomas/Stellar/blob/develop/docs/guides/desktop-development.md).
