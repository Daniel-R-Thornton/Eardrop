/**
 * Audio device enumeration and selection.
 */

export interface DeviceInfo {
  id: string;
  label: string;
  groupId: string;
}

export type DeviceList = { inputs: DeviceInfo[]; outputs: DeviceInfo[] };

/**
 * Fired once capture actually starts, i.e. the moment microphone permission
 * exists and the browser will finally hand over real device names and the
 * full list. Nothing re-enumerated after that before, so the placeholder
 * names from the first (pre-permission) enumeration stuck for the session.
 */
export const DEVICES_CHANGED_EVENT = 'eardrop-devices-changed';

/** Enumerate all audio input/output devices */
export async function enumerateDevices(): Promise<DeviceList> {
  // Request mic permission first so labels populate
  // user may deny — labels stay empty

  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs: DeviceInfo[] = [];
  const outputs: DeviceInfo[] = [];

  // An empty label means the page has no microphone permission YET — browsers
  // withhold names until it is granted, and expose only a single placeholder
  // per kind while withholding them. "Mic 1" therefore reads as "this device
  // has one microphone", which on a phone is simply wrong and sends you
  // looking for a hardware problem that isn't there. Say what is actually
  // going on instead. (The list is re-enumerated once capture starts — see
  // DEVICES_CHANGED_EVENT.)
  for (const dev of all) {
    if (dev.kind === 'audioinput') {
      inputs.push({
        id: dev.deviceId,
        label: dev.label || 'Microphone (allow mic access to see names)',
        groupId: dev.groupId,
      });
    } else if (dev.kind === 'audiooutput') {
      outputs.push({
        id: dev.deviceId,
        label: dev.label || 'Speaker (allow mic access to see names)',
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

/**
 * Resolve a persisted device selection to a deviceId that exists NOW.
 *
 * Chrome derives deviceId as a salted hash whose salt is not permanent: it
 * rotates across browser restarts, profile changes and permission-state changes,
 * and on Linux (PulseAudio/PipeWire) device re-enumeration can change the
 * underlying identity too. Observed in one debugging session: FOUR distinct
 * deviceIds for two physical microphones, with groupId changing on every single
 * getUserMedia call.
 *
 * That makes a stored deviceId unreliable, and the failure is silent in a
 * particularly unhelpful way: getUserMedia is called with the constraint omitted
 * when the id is empty, so a stale selection quietly captures from the browser's
 * DEFAULT device instead. A different physical mic then produces a completely
 * different response, which is indistinguishable from the channel having changed.
 *
 * So resolve by LABEL, which is stable for a given physical device, and fall
 * back to the id only if no label matches.
 *
 * @returns the resolved id, or '' for "use the browser default"
 */
export async function resolveInputDevice(
  storedId: string,
  storedLabel: string,
): Promise<{ id: string; label: string; matchedBy: 'id' | 'label' | 'default' }> {
  const { inputs } = await enumerateDevices();

  const byId = storedId ? inputs.find((d) => d.id === storedId) : undefined;
  if (byId) return { id: byId.id, label: byId.label, matchedBy: 'id' };

  const byLabel = storedLabel ? inputs.find((d) => d.label === storedLabel) : undefined;
  if (byLabel) return { id: byLabel.id, label: byLabel.label, matchedBy: 'label' };

  return { id: '', label: '', matchedBy: 'default' };
}

/** Label for a deviceId that exists now, or '' if it cannot be found. */
export async function labelForInputDevice(deviceId: string): Promise<string> {
  if (!deviceId) return '';
  const { inputs } = await enumerateDevices();
  return inputs.find((d) => d.id === deviceId)?.label ?? '';
}
