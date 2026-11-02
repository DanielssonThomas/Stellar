use super::{
    contracts::IvyErrorCode, journal::WorkspaceDescriptor, workspace_capture::MAX_IMAGE_BYTES,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Setup {
    descriptor: WorkspaceDescriptor,
    image_port: u16,
    image_secret: String,
}

pub struct ImageEndpoint {
    port: u16,
    secret: String,
}
pub type SharedImageEndpoint = Arc<Mutex<Option<ImageEndpoint>>>;

pub fn configure(
    value: Value,
    slot: &SharedImageEndpoint,
) -> Result<WorkspaceDescriptor, IvyErrorCode> {
    let setup: Setup = serde_json::from_value(value).map_err(|_| IvyErrorCode::Protocol)?;
    if setup.descriptor.port == 0
        || setup.image_port == 0
        || setup.image_secret.len() != 64
        || !setup
            .image_secret
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || setup.descriptor.credential_ref.len() != 32
        || !setup
            .descriptor
            .credential_ref
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(IvyErrorCode::Protocol);
    }
    *slot.lock().map_err(|_| IvyErrorCode::Unavailable)? = Some(ImageEndpoint {
        port: setup.image_port,
        secret: setup.image_secret,
    });
    Ok(setup.descriptor)
}

pub fn send(slot: &SharedImageEndpoint, header: &Value, image: &[u8]) -> Result<(), IvyErrorCode> {
    if image.len() > MAX_IMAGE_BYTES || !image.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(IvyErrorCode::MalformedRequest);
    }
    let (port, secret) = {
        let current = slot.lock().map_err(|_| IvyErrorCode::Unavailable)?;
        let endpoint = current.as_ref().ok_or(IvyErrorCode::Unavailable)?;
        (endpoint.port, endpoint.secret.clone())
    };
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| IvyErrorCode::Unavailable)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| IvyErrorCode::Unavailable)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| IvyErrorCode::Unavailable)?;
    let mut line = serde_json::to_vec(&json!({"secret":secret,"header":header,"size":image.len()}))
        .map_err(|_| IvyErrorCode::Protocol)?;
    line.push(b'\n');
    if line.len() > 4096 {
        return Err(IvyErrorCode::MalformedRequest);
    }
    stream
        .write_all(&line)
        .and_then(|_| stream.write_all(image))
        .and_then(|_| stream.flush())
        .map_err(|_| IvyErrorCode::Unavailable)?;
    let mut ack = [0u8; 1];
    stream
        .read_exact(&mut ack)
        .map_err(|_| IvyErrorCode::Unavailable)?;
    if ack != [1] {
        return Err(IvyErrorCode::Unavailable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, sync::mpsc, thread};

    #[test]
    fn stalled_image_peer_does_not_lock_endpoint_during_disconnect() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = Arc::new(Mutex::new(None));
        configure(
            json!({"descriptor":{"port":12345,"credential_ref":"0123456789abcdef0123456789abcdef"},
            "image_port":listener.local_addr().unwrap().port(),"image_secret":"a".repeat(64)}),
            &endpoint,
        )
        .unwrap();
        let (accepted_tx, accepted_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            accepted_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        let send_endpoint = endpoint.clone();
        let sender = thread::spawn(move || {
            let mut image = vec![0; MAX_IMAGE_BYTES];
            image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            send(&send_endpoint, &json!({}), &image)
        });
        accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        *endpoint
            .try_lock()
            .expect("image transfer must not hold the control lock") = None;
        release_tx.send(()).unwrap();
        server.join().unwrap();
        assert!(sender.join().unwrap().is_err());
    }
}
