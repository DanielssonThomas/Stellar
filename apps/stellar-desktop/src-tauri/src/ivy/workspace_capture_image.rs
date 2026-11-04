use super::{IvyErrorCode, MAX_IMAGE_BYTES};
use ::image::{
    ExtendedColorType, ImageEncoder, RgbaImage,
    codecs::png::{CompressionType, FilterType, PngEncoder},
    imageops::thumbnail,
};

pub(super) fn encode(pixels: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, IvyErrorCode> {
    let mut image = RgbaImage::from_raw(width, height, pixels).ok_or(IvyErrorCode::Unavailable)?;
    if width > 4096 || height > 4096 {
        image = thumbnail(&image, 4096, 4096);
    }
    for _ in 0..4 {
        let mut bytes = Vec::new();
        PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::Adaptive)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ExtendedColorType::Rgba8,
            )
            .map_err(|_| IvyErrorCode::Unavailable)?;
        if bytes.len() <= MAX_IMAGE_BYTES {
            return Ok(bytes);
        }
        image = thumbnail(
            &image,
            (image.width() / 2).max(1),
            (image.height() / 2).max(1),
        );
    }
    Err(IvyErrorCode::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_small_pixels_and_downsizes_large_captures() {
        assert_eq!(encode(vec![0; 3], 2, 2), Err(IvyErrorCode::Unavailable));
        let bytes = encode(vec![255; 32 * 16 * 4], 32, 16).unwrap();
        let image = ::image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(image.dimensions(), (32, 16));
        assert_eq!(image.get_pixel(0, 0).0, [255; 4]);
        let bytes = encode(vec![0; 5000 * 2 * 4], 5000, 2).unwrap();
        assert!(bytes.len() <= MAX_IMAGE_BYTES);
        assert_eq!(::image::load_from_memory(&bytes).unwrap().width(), 4096);
    }

    #[test]
    fn complex_pixels_are_scaled_to_fit_the_image_transport() {
        let mut seed = 7_u32;
        let pixels = (0..1400 * 1400 * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            })
            .collect();
        let bytes = encode(pixels, 1400, 1400).unwrap();
        assert!(bytes.len() <= MAX_IMAGE_BYTES);
        let result = ::image::load_from_memory(&bytes).unwrap();
        assert!(result.width() < 1400 && result.height() < 1400);
    }
}
