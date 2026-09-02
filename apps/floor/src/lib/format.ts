/* NAV — formatting helpers */

export const fmt = {
  usd(v: number, d = 2): string {
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  /** Sub-cent USD prices without mid-number wrapping: $0.0₄961 = $0.0000961.
     Standard screener notation — subscript counts the zeros after "0.". */
  usdTiny(v: number): string {
    if (!Number.isFinite(v)) return "—";            // never render NaN/Infinity as a price
    if (v < 0) return "-" + this.usdTiny(-v);       // sign-correct for defensive completeness
    if (v === 0 || v >= 0.01) return this.usd(v, v >= 0.01 ? 4 : 2);
    const [mant, exp] = v.toExponential(2).split("e");
    const zeros = -parseInt(exp, 10) - 1;
    const digits = mant.replace(".", "").replace("-", "").slice(0, 3);
    if (zeros < 1) return this.usd(v, 4);
    const sub = String(zeros).split("").map((c) => "₀₁₂₃₄₅₆₇₈₉"[+c]).join("");
    return `$0.0${sub}${digits}`;
  },
  usdCompact(v: number): string {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(2);
  },
  compact(v: number): string {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(0);
  },
  num(v: number, d = 2): string {
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  pct(v: number, d = 2): string {
    return (v * 100).toFixed(d) + "%";
  },
  delta(v: number): string {
    return (v >= 0 ? "▲ " : "▼ ") + Math.abs(v).toFixed(2) + "%";
  },
};
