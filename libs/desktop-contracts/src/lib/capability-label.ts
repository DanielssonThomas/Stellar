import type { AppCapability } from '../generated';

export function capabilityLabel(capability: AppCapability): string {
  switch (capability.kind) {
    case 'native_window':
      return 'Native window controls';
    case 'contract_events':
      return 'Contract notifications';
    default:
      return unreachable(capability);
  }
}

function unreachable(value: never): never {
  void value;
  throw new Error('Unsupported desktop capability');
}
