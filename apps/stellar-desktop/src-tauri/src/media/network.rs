use std::net::{IpAddr, SocketAddr};
use tauri::Url;

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && (b == 168 || b == 0 || (b == 0 && c == 2)))
                && !(a == 192 && b == 88 && c == 99)
                && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && s[1] < 0x200)
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

pub fn url(value: &str) -> Result<Url, ()> {
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(());
    }
    let url = Url::parse(value).map_err(|_| ())?;
    let host = url.host_str().ok_or(())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !host.contains('.') && !host.contains(':')
        || [
            "localhost",
            ".localhost",
            ".local",
            ".internal",
            ".home",
            ".lan",
        ]
        .iter()
        .any(|s| host.trim_end_matches('.').ends_with(s))
    {
        return Err(());
    }
    if let Ok(ip) = host.trim_matches(['[', ']']).parse()
        && !public_ip(ip)
    {
        return Err(());
    }
    Ok(url)
}

pub async fn addresses(host: &str) -> Result<Vec<SocketAddr>, ()> {
    let addresses = tokio::net::lookup_host((host.trim_matches(['[', ']']), 443))
        .await
        .map_err(|_| ())?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.len() > 32 || addresses.iter().any(|a| !public_ip(a.ip()))
    {
        return Err(());
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn denies_private_mapped_reserved_and_alternate_protocols() {
        for value in [
            "http://example.com",
            "file:///secret",
            "https://user:pass@example.com",
            "https://127.1",
            "https://2130706433",
            "https://[::ffff:127.0.0.1]",
            "https://[2002:7f00:1::]",
            "https://example.local",
            "https://example.com:8443",
            "https://10.0.0.1",
            "https://169.254.169.254",
        ] {
            assert!(url(value).is_err(), "{value}");
        }
        assert!(url("https://example.com/reference").is_ok());
        for ip in [
            "0.0.0.0",
            "192.0.2.1",
            "198.51.100.2",
            "203.0.113.1",
            "100.64.0.1",
            "198.18.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
    }
}
