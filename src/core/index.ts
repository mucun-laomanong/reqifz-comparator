// Cache format version. Increment whenever the cache structure changes;
// old caches will then be automatically invalidated.
export const CACHE_VERSION = 4;

export interface SpecObjectIndex {
  id: string;               // Requirement object ID
  title: string;            // Title (usually derived from an attribute)
  description?: string;     // Truncated description summary
  offset: number;           // Byte offset in the decompressed XML stream
  length: number;           // Approximate node length
  children: SpecObjectIndex[]; // Child objects (tree structure)
  xml?: string;             // Raw XML string (not written to cache)
  hierarchyPath?: string[]; // Path from root to the current node
  attributes?: Record<string, string>; // Attribute LONG-NAME -> value
  /**
   * Raw attributes keyed by the original attribute definition ID
   * (before LONG-NAME substitution). Used by comparison adapters for
   * mapping and by tool detection for fingerprinting.
   */
  rawAttributes?: Record<string, string>;
  images?: { path: string; dataUrl: string }[]; // Embedded images (not written to cache)
  typeRef?: string;         // SPEC-OBJECT-TYPE-REF, e.g. "FUNC-REQ"
  typeName?: string;        // SPEC-OBJECT-TYPE LONG-NAME, e.g. "Functional Requirement"
}

/**
 * Compact cache entry: excludes `xml` and `images` to keep cache size small.
 */
export interface CachedSpecObject {
  id: string;
  title: string;
  offset: number;
  length: number;
  hierarchyPath?: string[];
  attributes?: Record<string, string>;
  rawAttributes?: Record<string, string>;
  typeRef?: string;
  typeName?: string;
  childrenIds: string[];    // Only store child IDs; references are rebuilt on deserialization
}

export interface CachedIndex {
  objects: CachedSpecObject[];
  rootIds: string[];
  /** REQ-IF-TOOL-ID extracted from the ReqIF header (may be undefined). */
  toolId?: string;
  /** SOURCE-TOOL-ID extracted from the ReqIF header (may be undefined). */
  sourceToolId?: string;
}

/**
 * Result returned by parseReqifz: the tree of spec objects plus
 * header-level tool identification used by adapter detection.
 */
export interface ParsedReqif {
  indexes: SpecObjectIndex[];
  toolId?: string;
  sourceToolId?: string;
}