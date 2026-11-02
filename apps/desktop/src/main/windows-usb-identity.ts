// Device-interface names and inventories must use the same physical identity.
// Win7 USB 3 drivers may change the enumerator or publish REV_xxxx metadata.
const childBus = /^(?:HID|USBSTOR|SCSI|STORAGE|SWD|ROOT|HTREE|BTHENUM|PCI)$/i;
const functionInterface = /&MI_[0-9A-F]{2}(?:&|\\|\||$)/i;

export function physicalUsbIdentity(id: string, bus = 'USB', hardware = ''): string | null {
  const parts = /^([^\\]+)\\([^\\]+)\\([^\\]+)$/.exec(id.trim().toUpperCase());
  if (!parts || childBus.test(parts[1]) || functionInterface.test(`${id}|${hardware}`)
    || /ROOT_HUB/i.test(`${parts[2]}|${hardware}`)) return null;
  if (parts[1] !== 'USB' && bus !== 'USB' && !/^USB\\/i.test(hardware)) return null;
  const model = /^(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(?:&|$)/i.exec(parts[2])
    || /^[^\\]+\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(?:&|$)/i.exec(hardware);
  return model ? `USB\\${model[1]}\\${parts[3]}`.toUpperCase() : null;
}

export function usbDeviceIdentity(path: unknown): string | null {
  if (typeof path !== 'string' || path.length > 2048) return null;
  const match = /^\\\\\?\\([A-Z0-9_]{1,64})#(VID_[0-9A-F]{4}&PID_[0-9A-F]{4}(?:&[^#]+)?)#([^#]+)#\{A5DCBF10-6530-11D2-901F-00C04FB951ED\}$/i.exec(path);
  return match ? physicalUsbIdentity(`${match[1]}\\${match[2]}\\${match[3]}`) : null;
}
