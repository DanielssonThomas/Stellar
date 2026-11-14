#![forbid(unsafe_code)]
//! Passive native consent contract and domain. No OS custody/verifier, launcher,
//! listener, host ticket adapter or capability activation is provided.

mod broker;
mod canonical;
mod capabilities;
mod control;
mod lanes;
mod launch;
mod manifest;
mod object_json;
mod packet;
mod protocol;
mod scope;
mod window;

pub use broker::Broker;
pub use capabilities::{Attachment, GrantIntent, HostConsumeSuccess, Verification};
pub use control::{
    ControlReply, ControlRequest, decode_control_reply, decode_control_request,
    encode_control_reply, encode_control_request,
};
pub use lanes::{Acceptance, ClientLane, ServerInput, ServerLane};
pub use launch::{LaunchManifest, decode_launch_manifest};
pub use manifest::{Artifact, CodeManifest, Role, decode_manifest};
pub use packet::PacketReader;
pub use protocol::{
    ChallengeRequest, Error, ErrorReply, PrepareRequest, Request, decode_error, decode_request,
    decode_response, encode_error, encode_response,
};
pub use scope::{Cancelled, DisplayScope, Origin, Prepared, Response, Ticket};
pub use window::{WindowFlow, WindowPhase};

#[cfg(test)]
#[path = "contract_tests.rs"]
mod tests;

#[cfg(test)]
mod launch_tests;

#[cfg(test)]
mod control_tests;
#[cfg(test)]
mod lanes_tests;

#[cfg(test)]
mod object_shape_tests;
