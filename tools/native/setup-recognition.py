"""Explicit Windows speech asset provisioning. Never called by the application."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request
import venv

ROOT = Path('D:/Hermes/profiles/ivy/recognition')
ASSETS = [
    ('kws-models', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
     'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a'),
    ('asr-models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
     '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad'),
    ('kws-models', 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20',
     '68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6'),
]
PHRASES = ['IVY', 'DONE', "I'M DONE", 'IM DONE', 'I AM DONE', 'THATS ALL', 'THAT IS ALL',
           'CLEAR', 'PROMPT', 'PROMPT CANCEL', 'NEW SESSION', 'RELOAD MCP',
           'END PROMPT', 'SEND PROMPT', 'SEND']


def keywords():
    import sentencepiece
    root = ROOT / 'models' / ASSETS[0][1]
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(root / 'bpe.model'))
    lines = [' '.join(tokenizer.encode(phrase, out_type=str)) + ' :1.0 #0.35 @' +
             phrase.lower().replace(' ', '_') for phrase in PHRASES]
    (root / 'stellar-keywords.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (root / 'stellar-empty.txt').write_text('', encoding='utf-8')
    root = ROOT / 'models' / ASSETS[2][1]
    lexicon = {}
    for line in (root / 'en.phone').read_text(encoding='utf-8').splitlines():
        word, *phones = line.split()
        lexicon.setdefault(word, phones)
    lines = []
    for phrase in PHRASES:
        if phrase == 'IM DONE':
            continue
        words = phrase.split() if phrase != 'RELOAD MCP' else ['RELOAD', 'M', 'C', 'P']
        phones = [phone for word in words for phone in lexicon.get(word, [])]
        if any(word not in lexicon for word in words):
            continue
        threshold = '0.35' if phrase == 'IVY' else '0.25'
        lines.append(' '.join(phones) + ' :1.0 #' + threshold + ' @' + phrase.lower().replace(' ', '_'))
    (root / 'stellar-keywords.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (root / 'stellar-empty.txt').write_text('', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', required=True)
    parser.add_argument('--keywords-only', action='store_true')
    args = parser.parse_args()
    if args.keywords_only:
        keywords()
        return
    python = ROOT / '.venv/Scripts/python.exe'
    if not python.is_file():
        venv.create(ROOT / '.venv', with_pip=True)
    subprocess.run([str(python), '-I', '-m', 'pip', 'install', '--require-hashes', '--only-binary=:all:', '-r',
                    str(Path(__file__).with_name('requirements-recognition.lock'))], check=True)
    folder = ROOT / 'models'
    folder.mkdir(parents=True, exist_ok=True)
    for release, name, digest in ASSETS:
        archive = folder / (name + '.tar.bz2')
        if not archive.is_file():
            url = f'https://github.com/k2-fsa/sherpa-onnx/releases/download/{release}/{name}.tar.bz2'
            with urllib.request.urlopen(url, timeout=60) as source, archive.open('xb') as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
        with archive.open('rb') as checked:
            if hashlib.file_digest(checked, 'sha256').hexdigest() != digest:
                raise ValueError('Speech archive checksum mismatch; provision stopped')
        with tarfile.open(archive) as source:
            source.extractall(folder, filter='data')
    subprocess.run([str(python), '-I', str(Path(__file__).resolve()), '--install', '--keywords-only'], check=True)
    settings = ROOT / 'recognition-settings.json'
    if not settings.exists():
        settings.write_text('{"command_silence_ms":240}\n', encoding='utf-8')
    print('Offline CPU recognition assets provisioned. Runtime never downloads assets.')


if __name__ == '__main__':
    main()
