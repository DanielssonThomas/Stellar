use super::host::Sink;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[cfg(windows)]
pub fn run(stop: Arc<AtomicBool>, sink: Sink) -> Result<(), ()> {
    wasapi::initialize_mta().ok().map_err(|_| ())?;
    let result = capture(stop, sink);
    wasapi::deinitialize();
    result
}

#[cfg(not(windows))]
pub fn run(_: Arc<AtomicBool>, _: Sink) -> Result<(), ()> {
    Err(())
}

#[cfg(windows)]
fn capture(stop: Arc<AtomicBool>, sink: Sink) -> Result<(), ()> {
    use super::dsp::Analyzer;
    use std::time::{Duration, Instant};
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};
    struct Stream(wasapi::AudioClient);
    impl Drop for Stream {
        fn drop(&mut self) {
            let _ = self.0.stop_stream();
        }
    }
    let enumerator = DeviceEnumerator::new().map_err(|_| ())?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|_| ())?;
    let device_id = device.get_id().map_err(|_| ())?;
    let mut client = device.get_iaudioclient().map_err(|_| ())?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::PollingShared {
                autoconvert: true,
                buffer_duration_hns: 1_000_000,
            },
        )
        .map_err(|_| ())?;
    let capture = client.get_audiocaptureclient().map_err(|_| ())?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    client.start_stream().map_err(|_| ())?;
    let _stream = Stream(client);
    sink(None);
    let mut left_analyzer = Analyzer::new(48000);
    let mut right_analyzer = Analyzer::new(48000);
    let mut tone = super::tone::ToneAnalyzer::new(48000);
    let mut buffer = Vec::new();
    let mut emitted = Instant::now();
    let mut device_checked = Instant::now();
    while !stop.load(Ordering::Acquire) {
        let frames = capture.get_next_packet_size().map_err(|_| ())?.unwrap_or(0) as usize;
        if frames > 48000 {
            return Err(());
        }
        if frames > 0 {
            buffer.resize(frames * 8, 0);
            let (read, info) = capture.read_from_device(&mut buffer).map_err(|_| ())?;
            if info.flags.silent {
                buffer.fill(0);
            }
            for frame in buffer[..read as usize * 8].as_chunks::<8>().0 {
                let left = f32::from_le_bytes(frame[..4].try_into().map_err(|_| ())?);
                let right = f32::from_le_bytes(frame[4..8].try_into().map_err(|_| ())?);
                left_analyzer.sample(left);
                right_analyzer.sample(right);
                tone.sample(left, right);
            }
            buffer.fill(0);
        }
        if emitted.elapsed() >= Duration::from_millis(33) {
            let levels = super::dsp::stereo_levels(left_analyzer.take(), right_analyzer.take());
            sink(Some(super::host::MusicFrame {
                tone: if levels.level > 0.005 {
                    tone.current()
                } else {
                    None
                },
                levels,
            }));
            emitted = Instant::now();
        }
        if device_checked.elapsed() >= Duration::from_millis(500) {
            let current = enumerator
                .get_default_device(&Direction::Render)
                .map_err(|_| ())?;
            if current.get_id().map_err(|_| ())? != device_id {
                return Err(());
            }
            device_checked = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}
