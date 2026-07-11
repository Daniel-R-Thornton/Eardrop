/**
 * MainApp.tsx — Eardrop UI with comprehensive debug dashboard.
 * Apple-inspired design: clean cards, tight typography, visible debug.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, setState, resetState } from './Store';
import { ToneMeter } from './components/ToneMeter';
import { BitAnalyzer } from './components/BitAnalyzer';
import { WaveformScope } from './components/WaveformScope';
import { SpectrumAnalyzer } from './components/SpectrumAnalyzer';
import { ModemScope } from './components/ModemScope';
import { StatusBadge } from './components/StatusBadge';
import { Card } from './components/Card';
import { Stat } from './components/Stat';
import { MeterBar } from './components/MeterBar';
import { ConstellationPlot } from './components/ConstellationPlot';
import { PipelineStrip } from './components/PipelineStrip';
import { debugLogger, STAGE } from '../modem/debug/debugger';
import { OFDM_SYMBOL_MS, OFDM_CP_MS, OFDM_DEFAULTS } from '../modem/types';
import { FRAME_SIZE, PAYLOAD_DATA_SIZE } from '../modem/protocol/atomicFrame';
import { TONE_COLORS, TONE_FREQUENCIES, formatSize } from './lib';

const GAP = 12;

const TABS: Array<[string, string]> = [
  ['transfer', 'transfer'],
  ['config', 'config'],
  ['scope', 'scope'],
  ['logs', 'logs'],
];

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════

export function MainApp() {
  const s = useStore((x) => x);
  const {debug} = s;

  useEffect(() => {
    (window as any).eardropRefreshDevices?.();
  }, []);

  const dispatch = (type: string, detail?: any) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));

  const [tab, setTab] = useState<string>(
    () => localStorage.getItem('eardrop_tab') || 'transfer',
  );
  useEffect(() => {
    localStorage.setItem('eardrop_tab', tab);
  }, [tab]);

  // Auto-set OFDM-compatible defaults when switching to OFDM mode
  useEffect(() => {
    if (s.useOFDM) {
      const updates: Partial<typeof s> = {};
      if (s.pilotFreqHz < 1500) {
        updates.pilotFreqHz = OFDM_DEFAULTS.pilotFreqHz;
      }
      if (s.toneCount < 8) {
        updates.toneCount = OFDM_DEFAULTS.toneCount;
      }
      if (Object.keys(updates).length > 0) {
        setState(updates);
      }
    }
  }, [s.useOFDM]);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setState({ selectedFile: { name: f.name, size: f.size } });
      dispatch('eardrop-file', { file: f });
    }
    e.target.value = '';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setState({ selectedFile: { name: f.name, size: f.size } });
      dispatch('eardrop-file', { file: f });
    }
  }, []);

  const snrColor = !debug
    ? '#6b7280'
    : debug.signalToNoise > 10
      ? '#34d399'
      : debug.signalToNoise > 3
        ? '#f59e0b'
        : '#f87171';

  return (
    <div
      data-theme={s.theme}
      style={{
        width: '100%',
        margin: '0 auto',
        padding: '20px 16px',
        fontFamily: 'var(--font-body)',
        color: 'var(--text)',
        minHeight: '100vh',
        transition: 'background 0.2s, color 0.2s',
      }}
    >
      {/* ═══ HEADER ═══ */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 className="ed-wordmark">
            <span className="glyph">◢◤</span>
            eardrop
          </h1>
          <p className="ed-tagline">file transfer over sound · no network · speaker → mic</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ed-status-pill" data-live={s.isListening ? 'true' : 'false'}>
            <span className="dot" />
            {s.isPlaying
              ? 'transmitting'
              : s.isListening
                ? (s.recvStatus?.msg ?? 'listening').replace(/^[^A-Za-z]*/, '') || 'listening'
                : 'idle'}
          </span>
          <button
            onClick={() => setState({ theme: s.theme === 'dark' ? 'light' : 'dark' })}
            className="theme-toggle"
            title="Toggle theme"
          >
            {s.theme === 'dark' ? '☀' : '🌙'}
          </button>
          <button
            onClick={() => {
              if (s.isListening) dispatch('eardrop-record');
              resetState();
            }}
            className="ed-btn danger"
            title="Reset UI to defaults"
          >
            reset
          </button>
        </div>
      </div>

      {/* ═══ PIPELINE ═══ */}
      <PipelineStrip />


      {/* ═══ TABS ═══ */}
      <div className="ed-tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className={`ed-tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ═══ TRANSFER ═══ */}
      <div style={{ display: tab === 'transfer' ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: GAP, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {/* Send */}
          <Card title="Send" accent="#818cf8">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.style.borderColor = '#818cf8';
              }}
              onDragLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
              onDrop={handleDrop}
              onClick={() => document.getElementById('fi')?.click()}
              style={{
                border: '2px dashed rgba(255,255,255,0.1)',
                borderRadius: 8,
                padding: '16px',
                textAlign: 'center',
                cursor: 'pointer',
                fontSize: 14,
                color: s.selectedFile ? '#e5e7eb' : '#6b7280',
                transition: 'border-color .2s',
              }}
            >
              {s.selectedFile
                ? `${s.selectedFile.name} (${formatSize(s.selectedFile.size)})`
                : 'Drop a file or click to browse'}
              <input id="fi" type="file" hidden onChange={handleFile} />
            </div>
            <button
              disabled={!s.selectedFile || s.isSending}
              onClick={() => dispatch('eardrop-send')}
              style={{
                width: '100%',
                marginTop: 10,
                padding: '10px 0',
                border: 'none',
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
                background: s.selectedFile ? '#818cf8' : 'rgba(255,255,255,0.06)',
                color: s.selectedFile ? '#fff' : '#4b5563',
                transition: 'all .15s',
              }}
            >
              {s.isSending ? 'Sending…' : 'Send as Audio'}
            </button>
            {s.isPlaying && (
              <button
                onClick={() => dispatch('eardrop-stop-playback')}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '8px 0',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: '#f87171',
                  color: '#fff',
                }}
              >
                Stop Playback
              </button>
            )}
            {s.sendStatus && <StatusBadge {...s.sendStatus} />}
          </Card>

        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {/* Receive */}
          <Card title="Receive" accent="#34d399">
            <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 10 }}>
              Place sender speaker near mic.
            </p>
            <button
              onClick={() => dispatch('eardrop-record')}
              style={{
                width: '100%',
                padding: '10px 0',
                border: 'none',
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer',
                background: s.isListening ? '#f87171' : '#34d399',
                color: '#fff',
                transition: 'all .15s',
              }}
            >
              {s.isListening ? 'Stop Listening' : 'Start Listening'}
            </button>
            {s.recvStatus && <StatusBadge {...s.recvStatus} />}
            {s.progress > 0 && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    height: 4,
                    background: 'rgba(255,255,255,0.06)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(s.progress, 100)}%`,
                      height: '100%',
                      background: '#34d399',
                      borderRadius: 2,
                      transition: 'width .3s',
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, color: '#6b7280', marginTop: 3, display: 'block' }}>
                  {s.progress}%
                </span>
              </div>
            )}
            {s.receivedFiles.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {s.receivedFiles.map((f, i) => (
                  <a
                    key={i}
                    href={f.url}
                    download={f.name}
                    style={{
                      padding: '6px 12px',
                      background: '#34d399',
                      color: '#000',
                      borderRadius: 6,
                      textDecoration: 'none',
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    {f.name} ({formatSize(f.size)})
                  </a>
                ))}
              </div>
            )}
          </Card>

        </div>
      </div>

      {/* ═══ CONFIG ═══ */}
      <div style={{ display: tab === 'config' ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: GAP, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {/* Config */}
          <Card title="Config" accent="#f59e0b">
            {/* Tone Count */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 12, color: '#6b7280' }}>Active Tones</span>
              <select
                value={s.toneCount}
                onChange={(e) => setState({ toneCount: parseInt(e.target.value) })}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: '#e5e7eb',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 5,
                  padding: '3px 8px',
                  fontSize: 12,
                }}
              >
                {s.useOFDM ? (
                  <>
                    <option value={8}>8 tones</option>
                    <option value={16}>16 tones</option>
                    <option value={32}>32 tones</option>
                  </>
                ) : (
                  <>
                    <option value={2}>2 tones</option>
                    <option value={4}>4 tones</option>
                    <option value={8}>8 tones</option>
                  </>
                )}
              </select>
            </div>

            {/* Hail Mary Mode */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 12, color: '#6b7280' }}>🚀 Hail Mary</span>
              <input
                type="checkbox"
                checked={s.diversityMode}
                onChange={(e) => setState({ diversityMode: e.target.checked })}
                style={{ accentColor: '#ef4444', width: 18, height: 18 }}
              />
            </div>

            {!s.useOFDM && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 12, color: '#6b7280' }}>Symbol Rate</span>
                <select
                  value={s.symbolsPerSec}
                  onChange={(e) => setState({ symbolsPerSec: parseInt(e.target.value) })}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: '#e5e7eb',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 5,
                    padding: '3px 8px',
                    fontSize: 12,
                  }}
                >
                  <option value={10}>10 sym/s</option>
                  <option value={25}>25 sym/s</option>
                  <option value={50}>50 sym/s</option>
                </select>
              </div>
            )}
            <div style={{ fontSize: 10, color: '#4b5563', marginTop: -4, marginBottom: 8 }}>
              {s.useOFDM
                ? (() => {
                    const symbolSec = (OFDM_SYMBOL_MS + OFDM_CP_MS) / 1000;
                    const bytesPerSym = Math.max(1, Math.floor(s.toneCount / 4));
                    const frameSyms = Math.ceil(FRAME_SIZE / bytesPerSym);
                    const netBps = Math.round((PAYLOAD_DATA_SIZE * 8) / (frameSyms * symbolSec));
                    const rawBps = Math.round((s.toneCount * 2) / symbolSec);
                    return `≈${netBps} bit/s net (${rawBps} raw)`;
                  })()
                : `${s.symbolsPerSec * s.toneCount} bit/s`}
            </div>

            {/* OFDM QPSK toggle */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 12, color: '#6b7280' }}>OFDM QPSK (cyclic‑prefix)</span>
              <input
                type="checkbox"
                checked={s.useOFDM}
                onChange={(e) => setState({ useOFDM: e.target.checked })}
                style={{ accentColor: '#ef4444', width: 18, height: 18 }}
              />
            </div>

            {/* Pilot Freq */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>Pilot Freq</span>
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: 'SF Mono, ui-monospace, monospace',
                    color: '#f59e0b',
                  }}
                >
                  {s.pilotFreqHz.toFixed(1)} Hz
                </span>
              </div>
              <input
                type="range"
                min={s.useOFDM ? "500" : "37.5"}
                max={s.useOFDM ? "4000" : "537.5"}
                step="25"
                value={s.pilotFreqHz}
                onChange={(e) => {
                  const raw = parseFloat(e.target.value);
                  const v = s.useOFDM
                    ? Math.round(raw / 25) * 25
                    : Math.round((raw - 12.5) / 25) * 25 + 12.5;
                  setState({ pilotFreqHz: v });
                  window.dispatchEvent(
                    new CustomEvent('eardrop-pilot-freq', { detail: { freq: v } }),
                  );
                }}
                style={{ width: '100%', accentColor: '#f59e0b' }}
              />
            </div>

            {/* Amp Threshold */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>Amp Threshold</span>
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: 'SF Mono, ui-monospace, monospace',
                    color: '#f59e0b',
                  }}
                >
                  {s.ampThresholdRatio.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min="0.05"
                max="0.5"
                step="0.05"
                value={s.ampThresholdRatio}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setState({ ampThresholdRatio: v });
                  window.dispatchEvent(
                    new CustomEvent('eardrop-thresholds', {
                      detail: { ampRatio: v, syncMul: s.syncStrongMultiplier },
                    }),
                  );
                }}
                style={{ width: '100%', accentColor: '#f59e0b' }}
              />
            </div>

            {/* Playback Volume */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>🔊 Play Vol</span>
                <span style={{ fontSize: 12, fontFamily: 'SF Mono', color: '#f59e0b' }}>{s.playbackVolume}×</span>
              </div>
              <input type="range" min="1" max="10" step="1" value={s.playbackVolume}
                onChange={(e) => setState({ playbackVolume: parseInt(e.target.value) })}
                style={{ width: '100%' }} />
            </div>

            {/* Mic Gain */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: '#6b7280' }}>🎤 Mic Gain</span>
                <span style={{ fontSize: 12, fontFamily: 'SF Mono', color: '#f59e0b' }}>{s.micGain}×</span>
              </div>
              <input type="range" min="1" max="20" step="1" value={s.micGain}
                onChange={(e) => setState({ micGain: parseInt(e.target.value) })}
                style={{ width: '100%' }} />
            </div>

            {/* Audio Devices */}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <select
                id="inputSelect"
                style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.04)',
                  color: '#e5e7eb',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 5,
                  padding: '4px 6px',
                  fontSize: 11,
                }}
              >
                <option value="">Default Mic</option>
              </select>
              <select
                id="outputSelect"
                style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.04)',
                  color: '#e5e7eb',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 5,
                  padding: '4px 6px',
                  fontSize: 11,
                }}
              >
                <option value="">Default Speaker</option>
              </select>
              <button
                id="refreshDevices"
                style={{
                  padding: '4px 8px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 5,
                  background: 'rgba(255,255,255,0.04)',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                ↻
              </button>
            </div>
          </Card>

        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {/* Actions */}
          <Card title="Actions" accent="#f59e0b">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => dispatch('eardrop-self-test')} style={btnSmall}>
                Self-Test
              </button>
              <button onClick={() => dispatch('eardrop-send-test')} style={btnSmall}>
                Send Test
              </button>
              <button onClick={() => dispatch('eardrop-calibration-test')} style={{ ...btnSmall, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}>
                Cal Only
              </button>
              <button onClick={() => dispatch('eardrop-single-frame')} style={{ ...btnSmall, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}>
                Single Frame
              </button>
              <button onClick={() => dispatch('eardrop-sentinel-only')} style={{ ...btnSmall, background: 'rgba(239,68,68,0.15)', color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}>
                Sentinel Only
              </button>
              <button onClick={() => dispatch('eardrop-audio-validation')} style={{ ...btnSmall, background: 'rgba(34,197,94,0.15)', color: '#22c55e', borderColor: 'rgba(34,197,94,0.3)' }}>
                Audio Check
              </button>
              <button onClick={() => dispatch('eardrop-full-sweep')} style={{ ...btnSmall, background: 'rgba(59,130,246,0.15)', color: '#3b82f6', borderColor: 'rgba(59,130,246,0.3)' }}>
                Full Sweep
              </button>
              <button onClick={() => dispatch('eardrop-multi-tone')} style={{ ...btnSmall, background: 'rgba(168,85,247,0.15)', color: '#a855f7', borderColor: 'rgba(168,85,247,0.3)' }}>
                Multi-Tone
              </button>
              <button onClick={() => dispatch('eardrop-interference')} style={{ ...btnSmall, background: 'rgba(236,72,153,0.15)', color: '#ec4899', borderColor: 'rgba(236,72,153,0.3)' }}>
                Interference
              </button>
              <button onClick={() => dispatch('eardrop-fine-sweep')} style={{ ...btnSmall, background: 'rgba(20,184,166,0.15)', color: '#14b8a6', borderColor: 'rgba(20,184,166,0.3)' }}>
                Fine Sweep
              </button>
              <button onClick={() => dispatch('eardrop-speed-sweep')} style={{ ...btnSmall, background: 'rgba(250,204,21,0.15)', color: '#facc15', borderColor: 'rgba(250,204,21,0.3)' }}>
                Speed Sweep
              </button>
              <button onClick={() => dispatch('eardrop-combo-sweep')} style={{ ...btnSmall, background: 'rgba(249,115,22,0.15)', color: '#f97316', borderColor: 'rgba(249,115,22,0.3)' }}>
                Combo Sweep
              </button>
              <button onClick={() => dispatch('eardrop-acoustic-speed')} style={{ ...btnSmall, background: 'rgba(220,38,38,0.15)', color: '#dc2626', borderColor: 'rgba(220,38,38,0.3)' }}>
                Acoustic Speed
              </button>
              <button onClick={() => dispatch('eardrop-download-wav')} style={btnSmall}>
                Download WAV
              </button>
            </div>
            <div
              id="selfTestResult"
              style={{
                fontSize: 11,
                color: '#6b7280',
                fontFamily: 'SF Mono, ui-monospace, monospace',
                marginTop: 6,
                minHeight: 16,
              }}
            />
          </Card>

        </div>
      </div>

      {/* ═══ SCOPE ═══ */}
      <div style={{ display: tab === 'scope' ? 'grid' : 'none', gridTemplateColumns: '1fr 1fr', gap: GAP, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {/* Decoder State */}
          <Card title="Decoder State" accent="#818cf8">
            {!debug ? (
              <div
                style={{ padding: '12px 0', color: '#6b7280', fontSize: 13, textAlign: 'center' }}
              >
                Listening for signal…
              </div>
            ) : (
              <>
                {/* Stats grid */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: '1px',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: 6,
                    overflow: 'hidden',
                    marginBottom: 10,
                  }}
                >
                  <div style={statBg}>
                    <Stat
                      label="Status"
                      value={
                        debug.inFrame ? 'DATA' : debug.noiseFrames < 25 ? 'Profiling' : 'Listening'
                      }
                      color={debug.inFrame ? '#34d399' : '#f59e0b'}
                    />
                  </div>
                  <div style={statBg}>
                    <Stat label="Sync" value={`${debug.consecutiveSync}`} color="#818cf8" />
                  </div>
                  <div style={statBg}>
                    <Stat
                      label="SNR"
                      value={`${debug.signalToNoise.toFixed(1)} dB`}
                      color={snrColor}
                    />
                  </div>
                  <div style={statBg}>
                    <Stat
                      label="Pilot"
                      value={`${debug.pilotFreq.toFixed(1)} Hz`}
                      color="#818cf8"
                    />
                  </div>
                  <div style={statBg}>
                    <Stat label="Bits" value={`${debug.bitsCollected}`} color="#e5e7eb" />
                  </div>
                  <div style={statBg}>
                    <Stat
                      label="Blocks"
                      value={`${debug.blocksDecoded}/${debug.blocksCrcFailed > 0 ? '⚠️' : '✓'}`}
                      color={debug.blocksCrcFailed > 0 ? '#f87171' : '#34d399'}
                    />
                  </div>
                </div>

                {/* Per-tone energies */}
                <div style={{ marginBottom: 10 }}>
                  {[0, 1, 2, 3].map((t) => (
                    <MeterBar
                      key={t}
                      val={debug.energies[t]}
                      peak={Math.max(...debug.energies, 0.1)}
                      color={TONE_COLORS[t]}
                      label={`${TONE_FREQUENCIES[t]}Hz`}
                    />
                  ))}
                </div>

                {/* Bit Analyzer */}
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#6b7280',
                      marginBottom: 6,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    Bit Analyzer
                  </div>
                  <BitAnalyzer debug={debug} />
                </div>

                {/* Noise floor */}
                <div
                  style={{
                    fontSize: 10,
                    color: '#4b5563',
                    fontFamily: 'SF Mono, ui-monospace, monospace',
                  }}
                >
                  Noise: {debug.noiseFloor.map((n) => n.toExponential(1)).join(' | ')}
                </div>

                {/* Frame trace log */}
                {s.debugTrace && s.debugTrace.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div
                      style={{
                        fontSize: 11,
                        color: '#6b7280',
                        marginBottom: 6,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Frame Trace ({s.debugTrace.length})
                    </div>
                    <div
                      style={{
                        maxHeight: 180,
                        overflow: 'auto',
                        background: 'rgba(0,0,0,0.4)',
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.05)',
                        fontFamily: 'SF Mono, ui-monospace, monospace',
                        fontSize: 10,
                      }}
                    >
                      {s.debugTrace.slice(-40).map((entry, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            gap: 8,
                            padding: '2px 8px',
                            borderBottom: '1px solid rgba(255,255,255,0.03)',
                            alignItems: 'center',
                          }}
                        >
                          <span style={{ color: '#4b5563', minWidth: 32 }}>#{entry.sym}</span>
                          <span style={{ color: '#e5e7eb', minWidth: 70 }}>
                            {entry.bits.map((b, ti) => (
                              <span key={ti} style={{ color: b ? '#f87171' : '#818cf8' }}>
                                {b}
                              </span>
                            ))}
                          </span>
                          <span style={{ color: '#6b7280', minWidth: 40 }}>0x{entry.frameHex}</span>
                          <span
                            style={{
                              color: '#6b7280',
                              flex: 1,
                              textAlign: 'right',
                              fontSize: 9,
                            }}
                          >
                            I=[{entry.rawI.map((v) => v.toFixed(3)).join(',')}]
                          </span>
                          {entry.blockEvent && (
                            <span
                              style={{
                                color: '#34d399',
                                fontSize: 9,
                                fontWeight: 600,
                                background: 'rgba(52,211,153,0.15)',
                                padding: '1px 6px',
                                borderRadius: 3,
                              }}
                            >
                              {entry.blockEvent}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>


          {/* Diagnostics */}
          {s.diagMessages.length > 0 && (
            <Card title="Diagnostics" accent="#f59e0b">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                {s.diagMessages.map((m, i) => {
                  const isGood = m.startsWith('✓');
                  const isBad = m.startsWith('✗');
                  const isWarn = m.startsWith('⚠');
                  return (
                    <div
                      key={i}
                      style={{
                        color: isGood
                          ? '#34d399'
                          : isBad
                            ? '#f87171'
                            : isWarn
                              ? '#f59e0b'
                              : '#e5e7eb',
                        fontFamily: isGood || isBad ? 'SF Mono, monospace' : undefined,
                      }}
                    >
                      {m}
                    </div>
                  );
                })}
                <button
                  onClick={() => setState({ diagMessages: [] })}
                  style={{
                    alignSelf: 'flex-start',
                    marginTop: 4,
                    padding: '2px 8px',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 4,
                    background: 'rgba(255,255,255,0.04)',
                    color: '#6b7280',
                    cursor: 'pointer',
                    fontSize: 10,
                  }}
                >
                  Clear
                </button>
              </div>
            </Card>
          )}

        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {/* Constellation */}
          <Card title="Constellation" accent="#c084fc">
            <div style={{ display: 'flex', justifyContent: 'space-around' }}>
              {[0, 1, 2, 3].map((t) => (
                <ConstellationPlot
                  key={t}
                  iVal={debug?.relI[t] ?? 0}
                  qVal={debug?.relQ[t] ?? 0}
                  color={TONE_COLORS[t]}
                  label={`T${t}`}
                />
              ))}
            </div>
          </Card>


          {/* Modem Debug Scope */}
          <Card title="Modem Scope — Phase + Energy" accent="#f472b6">
            <ModemScope
              trace={s.debugTrace}
              energies={(s.debug?.energies || [0, 0, 0, 0]) as [number, number, number, number]}
              relI={(s.debug?.relI || [0, 0, 0, 0]) as [number, number, number, number]}
              relQ={(s.debug?.relQ || [0, 0, 0, 0]) as [number, number, number, number]}
              inFrame={s.debug?.inFrame || false}
              pilotFreq={s.debug?.pilotFreq || 0}
              pilotAmp={s.debug?.pilotAmplitude || 0}
            />
          </Card>


        <Card title="Spectrum — FFT + Waterfall" accent="#818cf8">
          <SpectrumAnalyzer
            spectrum={s.fftSpectrum}
            rawPeak={s.rawPeak}
            noiseFloorDb={s.noiseFloorDb}
            sampleRate={3200}
          />
        </Card>


        <Card title="Waveform — RX (blue) / TX (orange)" accent="#6c6cff">
          <WaveformScope rxSamples={s.debugSamples} txSamples={s.txSamples} sampleRate={3200} />
        </Card>

        </div>
      </div>

      {/* ═══ LOGS ═══ */}
      <div style={{ display: tab === 'logs' ? 'block' : 'none' }}>
          {/* Debug Toggles */}
          <Card title="Debug Logs" accent="#6b7280" style={{ fontSize: 12 }}>
            <DebugToggles />
          </Card>

      </div>
    </div>
  );
}

const statBg: React.CSSProperties = { background: 'var(--surface2)', padding: '10px 12px' };

const btnSmall: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 90,
  padding: '8px 12px',
  border: '1px solid var(--border2)',
  borderRadius: 6,
  background: 'var(--input-bg)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
};

// ─── Debug Toggles Component ───────────────────────────

const DEBUG_CATEGORIES = [
  'recorder',
  'player',
  'tx',
  'rx',
  'ofdm',
  'preamble',
  'channel',
  'app',
  'general',
] as const;

function DebugToggles() {
  const [flags, setFlags] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const cat of DEBUG_CATEGORIES) {
      const stored = (() => {
        try { return sessionStorage.getItem(`dbg_${cat}`); } catch { return null; }
      })();
      initial[cat] = stored !== null ? stored === '1' : false;
    }
    return initial;
  });

  const toggle = (cat: string) => {
    const next = !flags[cat];
    (window as any).debug?.set(cat, next);
    setFlags((prev) => ({ ...prev, [cat]: next }));
  };

  const allOn = Object.values(flags).every(Boolean);
  const toggleAll = () => {
    const next = !allOn;
    (window as any).debug?.all(next);
    const updated: Record<string, boolean> = {};
    for (const cat of DEBUG_CATEGORIES) updated[cat] = next;
    setFlags(updated);
  };

  const categoryColor = (cat: string): string => {
    const colors: Record<string, string> = {
      recorder: '#34d399',
      player: '#60a5fa',
      tx: '#f59e0b',
      rx: '#a78bfa',
      ofdm: '#f472b6',
      preamble: '#34d399',
      channel: '#9ca3af',
      app: '#6b7280',
      general: '#6b7280',
    };
    return colors[cat] || '#6b7280';
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <button
          onClick={toggleAll}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            border: '1px solid var(--border2)',
            borderRadius: 4,
            background: allOn ? 'rgba(52,211,153,0.15)' : 'rgba(107,114,128,0.15)',
            color: allOn ? '#34d399' : '#6b7280',
            cursor: 'pointer',
          }}
        >
          {allOn ? 'All On' : 'All Off'}
        </button>
        <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>
          Click labels to toggle log output
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {DEBUG_CATEGORIES.map((cat) => (
          <label
            key={cat}
            onClick={() => toggle(cat)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              cursor: 'pointer',
              padding: '3px 8px',
              borderRadius: 12,
              border: `1px solid ${categoryColor(cat)}40`,
              background: flags[cat]
                ? `${categoryColor(cat)}15`
                : 'transparent',
              opacity: flags[cat] ? 1 : 0.4,
              fontSize: 12,
              userSelect: 'none',
              transition: 'all 0.15s',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: flags[cat] ? categoryColor(cat) : 'transparent',
                border: flags[cat] ? 'none' : '1px solid #444',
              }}
            />
            {cat}
          </label>
        ))}
      </div>
    </div>
  );
}
