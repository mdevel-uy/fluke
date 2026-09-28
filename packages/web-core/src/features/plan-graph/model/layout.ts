import type { PlanStep } from 'shared/types';

export const COL_WIDTH = 290;
export const ROW_HEIGHT = 160;

/**
 * Dependencias efectivas de cada paso: las declaradas que existen en el plan;
 * un paso sin dependencias sigue al anterior (los planes son casi lineales y
 * el agente no siempre declara el orden).
 */
export function effectiveDeps(steps: PlanStep[]): Map<number, number[]> {
  const sorted = [...steps].sort((a, b) => a.n - b.n);
  const ns = new Set(sorted.map((s) => s.n));
  const deps = new Map<number, number[]>();
  sorted.forEach((s, i) => {
    const declared = s.depends_on.filter((d) => d !== s.n && ns.has(d));
    deps.set(
      s.n,
      declared.length > 0 ? declared : i > 0 ? [sorted[i - 1].n] : []
    );
  });
  return deps;
}

/**
 * Capas por camino más largo: columna = 1 + la más profunda de sus
 * dependencias; dentro de la columna, filas centradas en y = 0. En vertical
 * (paneles angostos) las capas van de arriba hacia abajo.
 */
export function layoutSteps(
  steps: PlanStep[],
  vertical = false
): Map<number, { x: number; y: number }> {
  const deps = effectiveDeps(steps);
  const depth = new Map<number, number>();
  const visit = (n: number, stack: Set<number>): number => {
    const known = depth.get(n);
    if (known !== undefined) return known;
    if (stack.has(n)) return 0; // ciclo declarado por el agente: se corta
    stack.add(n);
    const d = Math.max(
      -1,
      ...(deps.get(n) ?? []).map((dep) => visit(dep, stack))
    );
    stack.delete(n);
    depth.set(n, d + 1);
    return d + 1;
  };
  const sorted = [...steps].sort((a, b) => a.n - b.n);
  sorted.forEach((s) => visit(s.n, new Set()));

  const layers = new Map<number, number[]>();
  sorted.forEach((s) => {
    const d = depth.get(s.n) ?? 0;
    layers.set(d, [...(layers.get(d) ?? []), s.n]);
  });

  const out = new Map<number, { x: number; y: number }>();
  layers.forEach((ns, d) => {
    ns.forEach((n, i) => {
      const offset = i - (ns.length - 1) / 2;
      out.set(
        n,
        vertical
          ? { x: offset * COL_WIDTH, y: d * ROW_HEIGHT }
          : { x: d * COL_WIDTH, y: offset * ROW_HEIGHT }
      );
    });
  });
  return out;
}
