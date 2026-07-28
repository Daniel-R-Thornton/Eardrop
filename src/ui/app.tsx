import { useState, useEffect } from 'react';
import { useStore } from './Store';
import { Panel } from './components/instrument/Panel';
import { TxPanel } from './views/TxPanel';
import { RxPanel } from './views/RxPanel';
import { FrequencySweep } from './views/FrequencySweep';

const dispatch = (type: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(type, { detail }));

export function App() {
  const [showFrequencySweep, setShowFrequencySweep] = useState(false);
  const s = useStore();

  useEffect(() => {
    const handleFrequencySweep = () => setShowFrequencySweep(true);
    window.addEventListener('eardrop-test-frequency', handleFrequencySweep);
    return () => window.removeEventListener('eardrop-test-frequency', handleFrequencySweep);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, display: 'flex', gap: 8, padding: 16 }}>
        <TxPanel />
        <RxPanel />
      </div>
      {showFrequencySweep && <FrequencySweep />}
    </div>
  );
}
