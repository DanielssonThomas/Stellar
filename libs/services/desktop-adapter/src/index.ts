export * from './lib/services/desktop-adapter.service';
export { DesktopAdapter, DesktopAdapterError } from './lib/desktop-adapter';
export {
  createBrowserDesktopTransport,
  createNativeDesktopTransport,
} from './lib/desktop-transport';
export type {
  DesktopTransport,
  NativeDesktopApi,
} from './lib/desktop-transport';
