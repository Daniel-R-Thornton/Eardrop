/**
 * Audio device enumeration and selection.
 */

export interface DeviceInfo {
  id: string;
  label: string;
  groupId: string;
}

export type DeviceList = { inputs: DeviceInfo[]; outputs: DeviceInfo[] };

/** Enumerate all audio input/output devices */
export async function enumerateDevices(): Promise<DeviceList> {
  // Request mic permission first so labels populate
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
    temp.getTracks().forEach((t) => t.stop());
  } catch {
    /* user may deny — labels stay empty */
  }

  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs: DeviceInfo[] = [];
  const outputs: DeviceInfo[] = [];

  for (const dev of all) {
    if (dev.kind === 'audioinput') {
      inputs.push({
        id: dev.deviceId,
        label: dev.label || `Mic ${inputs.length + 1}`,
        groupId: dev.groupId,
      });
    } else if (dev.kind === 'audiooutput') {
      outputs.push({
        id: dev.deviceId,
        label: dev.label || `Speaker ${outputs.length + 1}`,
        groupId: dev.groupId,
      });
    }
  }

  return { inputs, outputs };
}

/** Populate a <select> with device options, keeping a "System Default" entry */
export function populateSelect(
  select: HTMLSelectElement,
  devices: DeviceInfo[],
  selectedId: string,
  defaultLabel = 'System Default',
) {
  select.innerHTML = '';

  // Always offer the OS default (value '' → recorder/player fall back to default device)
  const def = document.createElement('option');
  def.value = '';
  def.textContent = defaultLabel;
  if (!selectedId) def.selected = true;
  select.appendChild(def);

  for (const dev of devices) {
    // Skip the browser's own 'default'/'communications' pseudo-devices — the '' entry covers them
    if (dev.id === 'default' || dev.id === 'communications') continue;
    const opt = document.createElement('option');
    opt.value = dev.id;
    opt.textContent = dev.label;
    if (dev.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
}
