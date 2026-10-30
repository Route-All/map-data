import type { LonLat } from './roadTile';
export type StateEvidence =
  | { kind: 'inside'; state: string }
  | { kind: 'boundary'; states: string[]; distanceMeters: number }
  | { kind: 'outside_us' }
  | { kind: 'unavailable'; reason: string };
export interface BoundaryIndex { schema: 1; perDegree: 4; source?: string; cells: Record<string, string | 0> }
export type BoundaryBlock = Record<string, Record<string, LonLat[][]>>;
export declare const SCHEMA: 1;
export declare const PER_DEGREE: 4;
export declare function cellKey(lon: number, lat: number): string;
export declare function blockKey(cell: string): string;
export declare function cellBounds(cell: string): { west: number; south: number; east: number; north: number };
export declare function encodeJson(value: unknown): Uint8Array;
export declare function decodeJson<T = unknown>(bytes: Uint8Array | ArrayBuffer): T;
export declare function clipRing(ring: LonLat[], box: { west: number; south: number; east: number; north: number }): LonLat[];
export declare function inRings(p: LonLat, rings: LonLat[][]): boolean;
export declare function distanceToEdge(p: LonLat, rings: LonLat[][], box?: { west: number; south: number; east: number; north: number }): number;
export declare function stateAt(index: BoundaryIndex | null, getBlock: (blockKey: string) => Promise<BoundaryBlock | null>, point: LonLat, opts?: { boundaryMeters?: number; coastMeters?: number }): Promise<StateEvidence>;
export declare function buildGrid(states: { code: string; polygons: LonLat[][][] }[], opts?: { round?: number }): { index: BoundaryIndex; blocks: Record<string, BoundaryBlock> };
