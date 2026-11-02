use super::contracts::IvyErrorCode;

pub fn deadline(now: u128, issued: &str) -> Result<u128, IvyErrorCode> {
    let value = issued.parse::<u128>().map_err(|_| IvyErrorCode::Protocol)?;
    if value.to_string() != issued || value > now.saturating_add(500) {
        return Err(IvyErrorCode::Protocol);
    }
    value
        .min(now)
        .checked_add(15_000)
        .ok_or(IvyErrorCode::Protocol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delayed_bridge_delivery_does_not_extend_deadline() {
        assert_eq!(deadline(25_000, "10000"), Ok(25_000));
        assert!(deadline(25_001, "10000").unwrap() <= 25_001);
        assert_eq!(deadline(10_000, "10001"), Ok(25_000));
        assert!(deadline(10_000, "10501").is_err());
        assert!(deadline(10_000, "01000").is_err());
    }
}
