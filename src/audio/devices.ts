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

/** Populate a <select> with device options */
export function populateSelect(
  select: HTMLSelectElement,
  devices: DeviceInfo[],
  selectedId: string,
) {
  select.innerHTML = '';
  for (const dev of devices) {
    const opt = document.createElement('option');
    opt.value = dev.id;
    opt.textContent = dev.label;
    if (dev.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
}
