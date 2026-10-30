/** [longitude, latitude], the app's Coord. */
export type LonLat = [number, number];
export declare const MAGIC: 'RAT2';
export declare const VERSION: 2;
export declare const HEADER_BYTES: 28;
export declare const PER_DEGREE: 4;
export declare const TAGS: readonly string[];
export declare function tileKey(lat: number, lon: number): string;
export declare function tilesForBox(west: number, south: number, east: number, north: number): string[];
export interface EncodeWay { id: string | number; ref?: string; name?: string; /** flat [lat, lon, ...] */ coords: number[]; tags?: Record<string, string | undefined> }
export declare function encodeTile(ways: EncodeWay[]): Uint8Array;
export interface GroupBox { offset: number; length: number; west: number; south: number; east: number; north: number }
export interface Group { ref: string; name: string; ways: { id: string; coords: LonLat[] }[] }
export interface DecodedTile {
  groupCount(): number;
  spatial(): GroupBox[];
  group(g: number): Group;
  groupsMatching(field: 'ref' | 'name', test: RegExp): number[];
  tags(wayId: string | number): Readonly<Record<string, string>>;
}
export declare function decodeTile(bytes: Uint8Array | ArrayBuffer, budget?: { left: number }): DecodedTile;
export declare class TileFormatError extends Error {}
export declare class TileBudgetError extends Error {}
export declare function pointSegment(p: LonLat, a: LonLat, b: LonLat): { meters: number; point: LonLat; t: number };
export interface WayNear { wayId: string; ref: string; name: string; coordinate: LonLat; distanceMeters: number; segment: number; coords: LonLat[]; tags: Readonly<Record<string, string>> }
export declare function waysNear(tiles: DecodedTile[], point: LonLat, radiusMeters: number): WayNear[];
