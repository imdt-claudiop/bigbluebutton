// Pure, React-free validator for the chart custom block's JSON spec.
// BlockNote propSchema values are primitives only, so the chart is persisted as
// a single JSON string and validated here at render time. Never throws: a
// malformed spec must degrade to an inline error, never crash the collaborative
// document.

export interface PieEntry {
  label: string;
  value: number;
}

export interface ScatterEntry {
  x: number;
  y: number;
  label?: string;
}

export interface PieChartSpec {
  type: 'pie';
  data: PieEntry[];
}

export interface ScatterChartSpec {
  type: 'scatter';
  data: ScatterEntry[];
}

export type ChartSpec = PieChartSpec | ScatterChartSpec;

export type ParseChartResult =
  | { ok: true; value: ChartSpec }
  | { ok: false; error: string };

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim() !== ''
);

const parsePieData = (data: unknown[]): PieEntry[] => data.reduce<PieEntry[]>((acc, entry) => {
  if (entry !== null && typeof entry === 'object') {
    const { label, value } = entry as Record<string, unknown>;
    if (isNonEmptyString(label) && isFiniteNumber(value) && value >= 0) {
      acc.push({ label, value });
    }
  }
  return acc;
}, []);

const parseScatterData = (data: unknown[]): ScatterEntry[] => data.reduce<ScatterEntry[]>((acc, entry) => {
  if (entry !== null && typeof entry === 'object') {
    const { x, y, label } = entry as Record<string, unknown>;
    if (isFiniteNumber(x) && isFiniteNumber(y)) {
      acc.push(isNonEmptyString(label) ? { x, y, label } : { x, y });
    }
  }
  return acc;
}, []);

export function parseChartSpec(spec: string): ParseChartResult {
  if (typeof spec !== 'string' || spec.trim() === '') {
    return { ok: false, error: 'No data' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Spec must be an object' };
  }

  const { type, data } = parsed as Record<string, unknown>;

  if (type !== 'pie' && type !== 'scatter') {
    return { ok: false, error: 'Unknown chart type' };
  }

  if (!Array.isArray(data)) {
    return { ok: false, error: '"data" must be an array' };
  }

  if (type === 'pie') {
    const pieData = parsePieData(data);
    if (pieData.length === 0) {
      return { ok: false, error: 'No data' };
    }
    return { ok: true, value: { type: 'pie', data: pieData } };
  }

  const scatterData = parseScatterData(data);
  if (scatterData.length === 0) {
    return { ok: false, error: 'No data' };
  }
  return { ok: true, value: { type: 'scatter', data: scatterData } };
}

export default parseChartSpec;
