export interface DagNode {
  id: string;
  type: 'trigger' | 'wait' | 'send' | 'branch' | 'exit';
  label: string;
}

export interface DagEdge {
  source: string;
  target: string;
  label?: string;
}

export interface Dag {
  nodes: DagNode[];
  edges: DagEdge[];
}

export const emptyDag: Dag = { nodes: [], edges: [] };
