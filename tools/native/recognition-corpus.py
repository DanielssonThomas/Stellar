"""Explicit offline synthetic stress corpus, separate from the frozen 144 trials."""
import argparse
import importlib.util
import json
from pathlib import Path
import wave

PHRASES = [
    ('wake', 'Ivy.', 'ivy', 'passive'),
    ('wake-request', 'Ivy, open my browser.', 'ivy', 'passive'),
    ('done', 'Done.', 'done', 'listening'),
    ('im-done', "I'm done.", 'done', 'listening'),
    ('i-am-done', 'I am done.', 'done', 'listening'),
    ('thats-all', "That's all.", 'done', 'listening'),
    ('that-is-all', 'That is all.', 'done', 'listening'),
    ('clear', 'Clear.', 'clear', 'listening'),
    ('prompt', 'Prompt.', 'prompt', 'listening'),
    ('cancel', 'Prompt cancel.', 'prompt cancel', 'composing'),
    ('reset', 'New session.', 'new session', 'listening'),
    ('reload', 'Reload MCP.', 'reload mcp', 'listening'),
    ('down', 'Down.', None, 'listening'),
    ('im-down', "I'm down by the door.", None, 'listening'),
    ('well-done', 'Well done.', None, 'listening'),
    ('all-done', 'All done.', None, 'listening'),
    ('promptly', 'Promptly return the document.', None, 'listening'),
    ('prompt-me', 'Prompt me when you are ready.', None, 'listening'),
    ('cancellation', 'Prompt cancellation is important.', None, 'composing'),
    ('clear-sentence', 'Clear skies are expected tomorrow.', None, 'listening'),
    ('clear-prefix', 'A clear explanation helps.', None, 'listening'),
    ('embedded-done', 'After I am done with the call we can leave.', None, 'listening'),
    ('embedded-prompt', 'Please prompt me after the next meeting.', None, 'listening'),
    ('embedded-reset', 'We need a new session tomorrow.', None, 'listening'),
    ('reset-suffix', 'New session notes are on the table.', None, 'listening'),
    ('reload-suffix', 'Reload MCP settings after lunch.', None, 'listening'),
    ('cancel-idle', 'Prompt cancel.', None, 'listening'),
    ('prompt-composing', 'Prompt.', None, 'composing'),
    ('near-wake', 'I mean, I think the other option is better.', None, 'passive'),
    ('embedded-wake', 'The person named Ivy is already here.', None, 'passive'),
    ('media', 'Tonight we discuss gardening, new technology, and the weather forecast.', None, 'passive'),
    ('long', 'Please keep the entire request together. I need a document explaining '
     'the changes from yesterday. Include the original requirements, the open questions, '
     'and the reasons behind each decision. Leave room for comments and check the dates.', None, 'listening'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--generate-offline', action='store_true')
    mode.add_argument('--import-legacy', action='store_true')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.import_legacy:
        import numpy as np
        if args.input is None:
            parser.error('--import-legacy requires --input')
        spec = importlib.util.spec_from_file_location('legacy', Path(__file__).with_name('benchmark-recognition.py'))
        harness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(harness)
        args.output.mkdir(parents=True, exist_ok=True)
        trials = []
        for voice, folder in [('af_heart', 'recognition-fixtures'), ('bf_emma', 'recognition-fixtures-emma')]:
            for name, text, expected, context in harness.PHRASES:
                original = harness.pcm(args.input / folder / (name+'.wav'))
                for speed in (.85, 1, 1.2):
                    audio = np.interp(np.arange(0, len(original), speed), np.arange(len(original)), original).round().astype('<i2')
                    identity = f'{voice}-{speed}-{name}'
                    with wave.open(str(args.output / (identity+'.wav')), 'wb') as out:
                        out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000); out.writeframes(audio.tobytes())
                    trials.append({'id': identity, 'text': text, 'expected': expected, 'mode': context,
                                   'voice': voice, 'speed': speed, 'condition': 'frozen-pitch-changing-resample'})
        (args.output / 'manifest.json').write_text(json.dumps({'fixtureKind': 'synthetic',
            'purpose': 'frozen-legacy-replay', 'trials': trials}, indent=2), encoding='utf-8')
        return
    # Uses already provisioned local Kokoro, never changes persona configuration.
    import numpy as np
    import soundfile as sf
    worker = Path('D:/Hermes/profiles/ivy/voice/local_worker.py')
    spec = importlib.util.spec_from_file_location('local_voice', worker)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    args.output.mkdir(parents=True, exist_ok=True)
    engine = module.Engine()
    engine.synthesize({'text': 'Calibration.', 'output': str(args.output / 'warmup.wav'),
                       'engine': 'kokoro', 'voice': 'af_heart'})
    trials = []
    for voice in ('af_bella', 'af_sarah', 'af_heart', 'bf_emma'):
        for speed in (.85, 1.2):
            cache = {}
            for name, text, expected, mode in PHRASES:
                audio, rate = engine.model.create(text, voice=voice, speed=speed,
                                                 lang='en-gb' if voice.startswith('bf_') else 'en-us')
                cache[name] = audio
                identity = f'{voice}-{speed}-{name}'
                sf.write(args.output / (identity + '.wav'), audio, rate, subtype='PCM_16')
                trials.append({'id': identity, 'text': text, 'expected': expected, 'mode': mode,
                               'voice': voice, 'speed': speed, 'condition': 'native-tts-tempo'})
            # A resumed sentence must not become a control merely because its first
            # word is a command. Keep the explicit pause in the negative reference.
            suffix, rate = engine.model.create('Skies are expected tomorrow.', voice=voice,
                                             speed=speed, lang='en-gb' if voice.startswith('bf_') else 'en-us')
            prefix = cache['clear']
            for gap in (250, 450, 800):
                def trim(audio):
                    active = np.flatnonzero(np.abs(audio) > .008)
                    return audio[active[0]:active[-1]+1] if len(active) else audio
                audio = np.concatenate([np.zeros(round(rate*.2)), trim(prefix),
                                        np.zeros(round(rate*gap/1000)), trim(suffix), np.zeros(rate)])
                identity = f'{voice}-{speed}-paused-clear-{gap}'
                sf.write(args.output / (identity + '.wav'), audio, rate, subtype='PCM_16')
                trials.append({'id': identity, 'text': 'Clear skies are expected tomorrow.',
                               'expected': None, 'mode': 'listening', 'voice': voice,
                               'speed': speed, 'condition': f'constructed-pause-{gap}ms'})
            print(f'Generated {voice} at {speed}: {len(trials)} trials', flush=True)
    manifest = {'fixtureKind': 'synthetic', 'purpose': 'stress-not-holdout',
                'tempo': 'Kokoro native speed; no pitch-changing resampling', 'trials': trials}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
