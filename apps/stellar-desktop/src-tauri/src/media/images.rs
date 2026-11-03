use super::{
    contracts::{ImagePreview, MediaError},
    network,
    proxy::PublicProxy,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{collections::VecDeque, io::Cursor, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore};

const MAX_BYTES: usize = 4 * 1024 * 1024;
pub struct Images {
    slots: Semaphore,
    cache: Mutex<VecDeque<(String, ImagePreview)>>,
}
impl Default for Images {
    fn default() -> Self {
        Self {
            slots: Semaphore::new(2),
            cache: Mutex::new(VecDeque::new()),
        }
    }
}
impl Images {
    pub async fn preview(
        &self,
        source: String,
        proxy: Arc<PublicProxy>,
    ) -> Result<ImagePreview, MediaError> {
        let _slot = self.slots.try_acquire().map_err(|_| MediaError::Limit)?;
        if source.starts_with("data:") {
            if source.len() > 512 * 1024 {
                return Err(MediaError::Limit);
            }
            let (header, data) = source.split_once(',').ok_or(MediaError::Blocked)?;
            if !matches!(
                header,
                "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
            ) {
                return Err(MediaError::Blocked);
            }
            let bytes = STANDARD.decode(data).map_err(|_| MediaError::Blocked)?;
            return tauri::async_runtime::spawn_blocking(move || decode(&bytes))
                .await
                .map_err(|_| MediaError::Unavailable)?;
        }
        let url = network::url(&source).map_err(|_| MediaError::Blocked)?;
        if let Some((_, preview)) = self
            .cache
            .lock()
            .await
            .iter()
            .find(|(key, _)| key == &source)
        {
            return Ok(preview.clone());
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(
                reqwest::Proxy::https(format!("http://127.0.0.1:{}", proxy.port))
                    .map_err(|_| MediaError::Unavailable)?,
            )
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| MediaError::Unavailable)?;
        let mut response = client
            .get(url)
            .header("Accept", "image/png,image/jpeg,image/webp")
            .send()
            .await
            .map_err(|_| MediaError::Unavailable)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err(MediaError::Limit);
        }
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("");
        if !matches!(mime, "image/png" | "image/jpeg" | "image/webp") {
            return Err(MediaError::Blocked);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| MediaError::Unavailable)?
        {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(MediaError::Limit);
            }
            bytes.extend_from_slice(&chunk);
        }
        let preview = tauri::async_runtime::spawn_blocking(move || decode(&bytes))
            .await
            .map_err(|_| MediaError::Unavailable)??;
        let mut cache = self.cache.lock().await;
        cache.push_back((source, preview.clone()));
        while cache.len() > 6
            || cache.iter().map(|(_, p)| p.data_uri.len()).sum::<usize>() > 12 * 1024 * 1024
        {
            cache.pop_front();
        }
        Ok(preview)
    }
}

fn raster_reader(bytes: &[u8]) -> Result<image::ImageReader<Cursor<&[u8]>>, MediaError> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| MediaError::Blocked)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    Ok(reader)
}

fn decode(bytes: &[u8]) -> Result<ImagePreview, MediaError> {
    let reader = raster_reader(bytes)?;
    let format = reader.format().ok_or(MediaError::Blocked)?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
    ) {
        return Err(MediaError::Blocked);
    }
    let (width, height) = reader.into_dimensions().map_err(|_| MediaError::Blocked)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_000_000 {
        return Err(MediaError::Limit);
    }
    let reader = raster_reader(bytes)?;
    let image = reader
        .decode()
        .map_err(|_| MediaError::Blocked)?
        .thumbnail(width.min(1600), height.min(1200));
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| MediaError::Unavailable)?;
    if output.get_ref().len() > MAX_BYTES {
        return Err(MediaError::Limit);
    }
    Ok(ImagePreview {
        data_uri: format!(
            "data:image/png;base64,{}",
            STANDARD.encode(output.into_inner())
        ),
        width: image.width(),
        height: image.height(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_executable_corrupt_and_oversized_rasters() {
        for bytes in [
            b"<svg onload='alert(1)'/>".as_slice(),
            b"<html>bad</html>",
            b"RIFF0000WEBPbad",
        ] {
            assert!(decode(bytes).is_err());
        }
        let image = image::DynamicImage::new_rgb8(24, 12);
        let mut data = Cursor::new(Vec::new());
        image.write_to(&mut data, image::ImageFormat::Png).unwrap();
        let preview = decode(data.get_ref()).unwrap();
        assert_eq!((preview.width, preview.height), (24, 12));
        assert!(preview.data_uri.starts_with("data:image/png;base64,"));
    }
    #[test]
    fn limits_compressed_metadata_before_reading_dimensions() {
        let bytes = include_bytes!("../../../../../tools/native/fixtures/compressed-metadata.png");
        assert!(bytes.len() < 128 * 1024);
        use image::ImageDecoder;
        let mut decoder = raster_reader(bytes).unwrap().into_decoder().unwrap();
        assert!(decoder.icc_profile().unwrap().is_none());
        let preview = decode(bytes).unwrap();
        assert_eq!((preview.width, preview.height), (1, 1));
    }
}
