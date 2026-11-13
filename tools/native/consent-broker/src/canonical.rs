use crate::Error;
use serde_json::Value;

/// Used only on already validated Rust-owned DTOs, never as a wire-decoding hop.
pub(crate) fn canonical(value: &Value, out: &mut Vec<u8>) -> Result<(), Error> {
    match value {
        Value::Object(map) => {
            out.push(b'{');
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, key).map_err(|_| Error::InvalidRequest)?;
                out.push(b':');
                canonical(&map[key], out)?;
            }
            out.push(b'}');
        }
        Value::Array(values) => {
            out.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    out.push(b',');
                }
                canonical(item, out)?;
            }
            out.push(b']');
        }
        _ => serde_json::to_writer(&mut *out, value).map_err(|_| Error::InvalidRequest)?,
    }
    Ok(())
}
