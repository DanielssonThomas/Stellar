use super::network;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, watch},
};

/// HTTPS CONNECT only. DNS is checked for every tunnel, then the checked IP is dialled directly.
/// No system proxy, redirect handling, HTTP forwarding or private-network tunnel is available.
pub struct PublicProxy {
    pub port: u16,
    shutdown: watch::Sender<bool>,
}

impl PublicProxy {
    pub async fn start() -> Result<Self, ()> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| ())?;
        let port = listener.local_addr().map_err(|_| ())?.port();
        let (shutdown, mut stop) = watch::channel(false);
        let slots = Arc::new(Semaphore::new(32));
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.changed() => break,
                    accepted = listener.accept() => {
                        let Ok((stream,peer)) = accepted else { break; };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                        let mut stopped = stop.clone();
                        tauri::async_runtime::spawn(async move {
                            let _slot = slot;
                            tokio::select! {
                                _ = stopped.changed() => {},
                                _ = tokio::time::timeout(Duration::from_secs(300), tunnel(stream)) => {},
                            }
                        });
                    }
                }
            }
        });
        Ok(Self { port, shutdown })
    }
}

impl Drop for PublicProxy {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

async fn tunnel(mut client: TcpStream) -> Result<(), ()> {
    let target = tokio::time::timeout(Duration::from_secs(10), async {
        let mut header = Vec::new();
        loop {
            if header.len() >= 8192 {
                return Err(());
            }
            header.push(client.read_u8().await.map_err(|_| ())?);
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let header = std::str::from_utf8(&header).map_err(|_| ())?;
        let mut line = header.lines().next().ok_or(())?.split(' ');
        if line.next() != Some("CONNECT") {
            return Err(());
        }
        let authority = line.next().ok_or(())?;
        if line.next() != Some("HTTP/1.1") || line.next().is_some() || !authority.ends_with(":443")
        {
            return Err(());
        }
        let url = network::url(&format!("https://{authority}/"))?;
        // Prevent URL parser normalization from admitting a different CONNECT authority.
        let host = url.host_str().ok_or(())?;
        if authority != format!("{host}:443") {
            return Err(());
        }
        let addresses = network::addresses(host).await?;
        for address in addresses {
            if let Ok(stream) = TcpStream::connect(address).await {
                return Ok(stream);
            }
        }
        Err(())
    })
    .await;
    let Ok(Ok(mut upstream)) = target else {
        let _ = client
            .write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            .await;
        return Err(());
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(|_| ())?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream)
        .await
        .map_err(|_| ())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn rejects_private_tunnels_http_forwarding_and_local_protocols() {
        let proxy = PublicProxy::start().await.unwrap();
        for request in [
            "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
            "CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n",
            "GET http://127.0.0.1/ HTTP/1.1\r\n\r\n",
            "CONNECT example.com:80 HTTP/1.1\r\n\r\n",
            "CONNECT example.com:443/../../:443 HTTP/1.1\r\n\r\n",
        ] {
            let mut client = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
            client.write_all(request.as_bytes()).await.unwrap();
            let mut bytes = [0; 256];
            let count = tokio::time::timeout(Duration::from_secs(2), client.read(&mut bytes))
                .await
                .unwrap()
                .unwrap();
            assert!(
                std::str::from_utf8(&bytes[..count])
                    .unwrap()
                    .starts_with("HTTP/1.1 403")
            );
        }
    }
}
