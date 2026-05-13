export interface GraphNodeDto { id: string; username: string | null; title: string | null; subs: number | null; isMine: boolean; }
export interface GraphEdgeDto { source: string; target: string | null; target_username: string; count: number; kind: string; last_seen: string; }
export interface GraphDto     { nodes: GraphNodeDto[]; edges: GraphEdgeDto[]; }
