/**
 * Fixed-point text like Python's format(v, ".Nf"): exact halves round to even
 * (6.25 -> "6.2"), where Number.toFixed rounds them up. Keeps the TypeScript
 * tools' output identical to the Python ones.
 */
export function fixed(v: number, digits: number): string {
  if (Number.isNaN(v)) return "nan";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    roundingMode: "halfEven",
    useGrouping: false,
  }).format(v);
}
