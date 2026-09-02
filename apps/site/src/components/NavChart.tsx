import { useEffect, useRef } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
} from "chart.js";
import { fmt } from "../lib/format";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

export interface NavSeries {
  labels: string[];
  data: number[];
}

/** NAV/token stepped line — CRT green on ink. Pass series=null with a
    placeholder describing the true launch state: the chart starts printing
    from the first on-chain accumulation epoch after TGE. */
export function NavChart({ series, placeholder }: {
  series: NavSeries | null;
  placeholder?: { badge: string; note: string };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !series) return;
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: series.labels,
        datasets: [
          {
            data: series.data,
            borderColor: "#4ae58a",
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            backgroundColor: "rgba(74,229,138,0.06)",
            tension: 0,
            stepped: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        plugins: {
          tooltip: {
            backgroundColor: "#0b1622",
            borderColor: "#1b3049",
            borderWidth: 1,
            titleFont: { family: "Switzer" },
            bodyFont: { family: "Switzer" },
            callbacks: { label: (c) => " VAULT " + fmt.usd(c.parsed.y ?? 0, 2) },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "#8fa3b8", maxTicksLimit: 6, font: { family: "Switzer", size: 11 } },
          },
          y: {
            grid: { color: "rgba(27,48,73,0.6)" },
            ticks: {
              color: "#8fa3b8",
              font: { family: "Switzer", size: 11 },
              callback: (v) => fmt.usdCompact(Number(v)),
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [series]);

  if (!series) {
    const badge = placeholder?.badge ?? "NO DATA YET";
    const note = placeholder?.note ?? "The vault series is reconstructed from on-chain transfer logs. Nothing is drawn here until the chain has printed it.";
    return (
      <div className="chart-box prelaunch-box" role="img" aria-label={`Vault value chart — ${badge.toLowerCase()}`}>
        <span className="stat-value num text-[34px] md:text-[44px]">—</span>
        <span className="px-label text-gold">{badge}</span>
        <span className="text-[13px] text-muted-dark max-w-[38em] text-center">{note}</span>
      </div>
    );
  }

  return (
    <div className="chart-box">
      <canvas ref={canvasRef} aria-label="Vault value over time, one step per accumulation epoch" role="img" />
    </div>
  );
}
