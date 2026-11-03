import type { BrowserEvent, ImagePreview } from '../generated';
import { boundedString, DesktopContractError, record } from './wire-validation';

export function decodeBrowserEvent(value: unknown): BrowserEvent {
  const data = record(value, ['id', 'url', 'state', 'generation']);
  const id = boundedString(data['id'], 36),
    url = boundedString(data['url'], 8192),
    state = data['state'];
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    !['loading', 'ready', 'blocked', 'failed', 'focused'].includes(
      String(state),
    )
  )
    throw new DesktopContractError('malformed');
  const generation = data['generation'];
  if (
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > 4294967295
  )
    throw new DesktopContractError('malformed');
  return { id, url, generation, state: state as BrowserEvent['state'] };
}
export function decodeImagePreview(value: unknown): ImagePreview {
  const data = record(value, ['data_uri', 'width', 'height']);
  const src = boundedString(data['data_uri'], 6 * 1024 * 1024),
    width = data['width'],
    height = data['height'];
  if (
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(src) ||
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > 1600 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 1200
  )
    throw new DesktopContractError('malformed');
  return { data_uri: src, width, height };
}
