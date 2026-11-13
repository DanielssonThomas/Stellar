//! Streaming shape gate for this closed protocol. No intermediate map/Value may
//! discard duplicate keys before the original bytes undergo typed deserialization.
use crate::Error;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::fmt;

#[derive(Clone, Copy)]
enum Shape {
    Object,
    Objects,
    Strings,
    Scalar,
}

struct Gate {
    shape: Shape,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for Gate {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        if self.depth > 8 {
            return Err(de::Error::custom("shape depth"));
        }
        match self.shape {
            Shape::Object => d.deserialize_map(self),
            Shape::Objects | Shape::Strings => d.deserialize_seq(self),
            Shape::Scalar => d.deserialize_any(self),
        }
    }
}

impl<'de> Visitor<'de> for Gate {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("closed object, declared vector or scalar")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        if !matches!(self.shape, Shape::Object) {
            return Err(de::Error::custom("unexpected object"));
        }
        while let Some(key) = map.next_key::<String>()? {
            let shape = match key.as_str() {
                "request" | "params" | "origin" | "displayScope" | "result" | "error" => {
                    Shape::Object
                }
                "artifacts" => Shape::Objects,
                "effects" | "pythonFlags" => Shape::Strings,
                _ => Shape::Scalar,
            };
            map.next_value_seed(Gate {
                shape,
                depth: self.depth + 1,
            })?;
        }
        Ok(())
    }

    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<(), S::Error> {
        match self.shape {
            Shape::Objects => {
                while seq
                    .next_element_seed(Gate {
                        shape: Shape::Object,
                        depth: self.depth + 1,
                    })?
                    .is_some()
                {}
            }
            Shape::Strings => while seq.next_element::<String>()?.is_some() {},
            _ => return Err(de::Error::custom("unexpected array")),
        }
        Ok(())
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        self.scalar()
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        self.scalar()
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        self.scalar()
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        self.scalar()
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        self.scalar()
    }
    fn visit_string<E: de::Error>(self, _: String) -> Result<(), E> {
        self.scalar()
    }
}

impl Gate {
    fn scalar<E: de::Error>(&self) -> Result<(), E> {
        if matches!(self.shape, Shape::Scalar) {
            Ok(())
        } else {
            Err(de::Error::custom("unexpected scalar"))
        }
    }
}

pub(crate) fn check(bytes: &[u8]) -> Result<(), Error> {
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    Gate {
        shape: Shape::Object,
        depth: 0,
    }
    .deserialize(&mut decoder)
    .map_err(|_| Error::InvalidRequest)?;
    decoder.end().map_err(|_| Error::InvalidRequest)
}
