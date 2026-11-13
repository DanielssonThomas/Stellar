#![forbid(unsafe_code)]
//! Passive native consent contract and domain. No OS custody/verifier, launcher,
//! listener, host ticket adapter or capability activation is provided.

mod broker;
mod canonical;
mod launch;
mod manifest;
mod protocol;
mod scope;

pub use broker::{Attachment, Broker, GrantIntent, Verification};
pub use launch::{LaunchManifest, decode_launch_manifest};
pub use manifest::{Artifact, CodeManifest, Role, decode_manifest};
pub use protocol::{
    Error, ErrorReply, Request, decode_error, decode_request, decode_response, encode_error,
    encode_response,
};
pub use scope::{Cancelled, DisplayScope, Origin, Prepared, Response, Ticket};

#[cfg(test)]
#[path = "contract_tests.rs"]
mod tests;

#[cfg(test)]
mod launch_tests;
