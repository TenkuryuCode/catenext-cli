export interface DependencyEdge {
  task: string;
  dependsOn: string;
}

/**
 * Mencari siklus di graf dependensi task. Mengembalikan jalur siklus
 * (mis. ["a", "b", "c", "a"]) atau null bila graf adalah DAG.
 */
export function findCycle(edges: readonly DependencyEdge[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const { task, dependsOn } of edges) {
    const list = graph.get(task);
    if (list) list.push(dependsOn);
    else graph.set(task, [dependsOn]);
    if (!graph.has(dependsOn)) graph.set(dependsOn, []);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}
