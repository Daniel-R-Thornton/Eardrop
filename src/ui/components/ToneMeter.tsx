/**
 * ToneMeter.tsx — Per-tone energy bars with frequency labels.
 */

import React from "react";

interface Props {
  energies: number[];
  freqs: number[];
  colors: string[];
}

export const ToneMeter: React.FC<Props> = ({ energies, freqs, colors }) => {
  const maxE = Math.max(...energies, 1e-12);

  return (
    <div style={{ padding: "4px 12px 8px" }}>
      <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Tone Energy</div>
      <div style={{ display: "flex", gap: 3 }}>
        {[0, 1, 2, 3].map(t => {
          const pct = Math.min(100, (energies[t] / maxE) * 100);
          return (
            <div key={t} style={{ flex: 1, position: "relative", height: 24 }}>
              <div style={{
                position: "absolute", bottom: 0, left: 0, right: 0,
                height: `${pct}%`,
                background: colors[t],
                borderRadius: "3px 3px 0 0",
                transition: "height 50ms linear",
                opacity: 0.8,
              }} />
              <div style={{
                position: "absolute", bottom: -14, left: 0, right: 0,
                textAlign: "center", fontSize: 8, color: colors[t],
              }}>
                {freqs[t]}Hz
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
