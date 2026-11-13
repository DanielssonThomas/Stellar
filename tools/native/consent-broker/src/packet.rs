use crate::protocol::{Error, MAX_FRAME};

/// Bounded byte framing only. A decoded payload is never authenticated evidence.
#[derive(Default)]
pub struct PacketReader {
    buffer: Vec<u8>,
    length: Option<usize>,
    sealed: bool,
}

impl PacketReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consume at most one packet; the caller retains the unconsumed input suffix.
    /// Empty input is not EOF. Call finish() when the byte stream actually closes.
    pub fn ingest(&mut self, input: &[u8]) -> Result<(usize, Option<Vec<u8>>), Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        let mut used = 0;
        if self.length.is_none() {
            let count = (4 - self.buffer.len()).min(input.len());
            self.buffer.extend_from_slice(&input[..count]);
            used += count;
            if self.buffer.len() != 4 {
                return Ok((used, None));
            }
            let size =
                u32::from_le_bytes(self.buffer[..4].try_into().expect("four-byte prefix")) as usize;
            if size == 0 || size > MAX_FRAME {
                self.sealed = true;
                return Err(Error::InvalidRequest);
            }
            self.buffer.clear();
            self.length = Some(size);
        }
        let size = self.length.expect("validated prefix");
        let count = (size - self.buffer.len()).min(input.len() - used);
        self.buffer.extend_from_slice(&input[used..used + count]);
        used += count;
        if self.buffer.len() != size {
            return Ok((used, None));
        }
        self.length = None;
        Ok((used, Some(std::mem::take(&mut self.buffer))))
    }

    /// Ok means a clean byte boundary only, not acknowledged requests/consent.
    pub fn finish(&mut self) -> Result<(), Error> {
        if self.sealed {
            return Err(Error::Uncertain);
        }
        self.sealed = true;
        if self.length.is_some() || !self.buffer.is_empty() {
            Err(Error::InvalidRequest)
        } else {
            Ok(())
        }
    }
}

pub(crate) fn packet(payload: Vec<u8>) -> Result<Vec<u8>, Error> {
    if payload.is_empty() || payload.len() > MAX_FRAME {
        return Err(Error::InvalidRequest);
    }
    let mut bytes = Vec::with_capacity(payload.len() + 4);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend(payload);
    Ok(bytes)
}
