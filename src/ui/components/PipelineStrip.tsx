/**
 * PipelineStrip.tsx — live "how it works" stage bar.
 *
 * TX lane: file → frames → modulate → speaker
 * RX lane: mic → align → train → demod → scan → file
 * The active stage highlights from existing store state — no new plumbing.
 */

import React from 'react';
import { useStore } from '../Store';

interface StageProps {
  label: string;
  active: boolean;
  done?: boolean;
}

function Stage({ label, active, done }: StageProps) {
  return <span className={`stage${active ? ' active' : ''}${done ? ' done' : ''}`}>{label}</span>;
}

function Arrow() {
  return <span className="arrow">→</span>;
}

export function PipelineStrip() {
  const s = useStore((x) => x);

  // TX stage: file selected → sending (isPlaying) → idle
  const txStage = s.isPlaying ? 'speaker' : s.selectedFile ? 'file' : 'idle';

  // RX stage from decoder status text + listening flags
  const rxMsg = s.recvStatus?.msg ?? '';
  let rxStage = 'idle';
  if (s.isListening) rxStage = 'mic';
  if (/CALIBRATION|SYNC/i.test(rxMsg)) rxStage = 'train';
  if (/HEADER|DATA/i.test(rxMsg)) rxStage = 'demod';
  if (/COMPLETE/i.test(rxMsg) || s.receivedFiles.length > 0) rxStage = 'file';

  const txStages: Array<[string, string]> = [
    ['file', 'file'],
    ['frames', 'frames'],
    ['modulate', s.useOFDM ? 'OFDM' : 'BPSK'],
    ['speaker', '🔊'],
  ];
  const rxStages: Array<[string, string]> = [
    ['mic', '🎙'],
    ['align', 'align'],
    ['train', 'train'],
    ['demod', 'demod'],
    ['scan', 'scan'],
    ['file', 'file'],
  ];

  const rxOrder = rxStages.map(([key]) => key);
  const rxIdx = rxOrder.indexOf(rxStage);

  return (
    <div className="ed-pipeline">
      <span className="lane">TX</span>
      {txStages.map(([key, label], i) => (
        <React.Fragment key={key}>
          {i > 0 && <Arrow />}
          <Stage label={label} active={txStage === key} />
        </React.Fragment>
      ))}
      <span className="sep" />
      <span className="lane">RX</span>
      {rxStages.map(([key, label], i) => (
        <React.Fragment key={key}>
          {i > 0 && <Arrow />}
          <Stage label={label} active={rxStage === key} done={rxIdx > i} />
        </React.Fragment>
      ))}
    </div>
  );
}
