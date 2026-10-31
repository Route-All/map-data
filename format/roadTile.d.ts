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

// ---- v3: read by byte ranges ----
export declare const MAGIC3: 'RAT3';
export declare const VERSION3: 3;
export declare const HEADER3_BYTES: 24;
export declare const CHUNK_TEXT: number;
export declare function encodeTile3(ways: EncodeWay[], key: string, opts?: { chunkText?: number }): Uint8Array;
/** Length of the head (header, table, ref index) from a tile's first 24 bytes. */
export declare function headLength(bytes: Uint8Array | ArrayBuffer): number;
/** A byte range of a v3 tile (offset from the tile's start) and the SHA-256 its bytes must have. */
export interface TileRange { offset: number; length: number; sha256: string }
export interface ChunkRange extends TileRange { west: number; south: number; east: number; north: number }
export interface Index { values: string[]; lists: number[][] }
export interface TileHead {
  chunks: ChunkRange[];
  nameIndex: TileRange;
  refIndex: Index;
  chunksIn(west: number, south: number, east: number, north: number): number[];
}
export declare function decodeHead(bytes: Uint8Array | ArrayBuffer): TileHead;
export declare function decodeIndex(bytes: Uint8Array | ArrayBuffer): Index;
export declare function chunksMatching(index: Index, test: RegExp): number[];
/** Chunks (already checked) as a DecodedTile, for waysNear and the ref/name readers. */
export declare function decodeChunks(chunks: (Uint8Array | ArrayBuffer)[], budget?: { left: number }): DecodedTile;

// ---- manifests (schema 3) ----
export declare const SCHEMA: 3;
export declare const BLOCK_TILES: 8;
export declare function blockOf(tileKey: string): string;
export interface ObjectRef { key: string; sha256: string; bytes: number }
/** roads/v2/<build>/manifest.json */
export interface RoadsManifest3 {
  schema: 3; buildId: string; builtAt: string; grid: { perDegree: 4; blockDegrees: 2 };
  coverage: { states: string[]; complete: boolean }; sourceDates: Record<string, string>; tileCount: number;
  blocks: Record<string, ObjectRef>;
}
/** A tile's place in its pack, and its head (the first range a reader fetches). */
export interface TileEntry { key: string; offset: number; bytes: number; sha256: string; head: number; headSha256: string }
/** roads/v2/blocks/<sha256>.json */
export interface BlockManifest { schema: 3; block: string; packs: ObjectRef[]; tiles: Record<string, TileEntry> }
export declare function sha256(data: Uint8Array | ArrayBuffer): Uint8Array;
export declare function bytesToHex(bytes: Uint8Array): string;
