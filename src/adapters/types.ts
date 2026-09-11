// Describes the mapping and comparison rules between a pair of tools.
export interface AdapterConfig {
  /** Unique identifier, e.g. 'doors-to-polarion' */
  id: string;
  /** Display name, e.g. 'DOORS → Polarion' */
  name: string;
  description?: string;

  /** Inherit rules from another config by its id (for shared defaults) */
  extends?: string;

  /** Detection rules (multi-level, from highest to lowest confidence). */
  detection?: {
    /** File name regex (medium confidence). */
    sourceToolPattern?: string;
    targetToolPattern?: string;
    /** Tool-id regex applied to REQ-IF-TOOL-ID / SOURCE-TOOL-ID (high confidence). */
    sourceToolIdPattern?: string;
    targetToolIdPattern?: string;
    /** Attribute-name regex (low confidence, fingerprint based). */
    sourceAttributePattern?: string;
    targetAttributePattern?: string;
  };

  /** How to determine that two objects represent the same requirement */
  idMatching: IdMatchingStrategy;

  /** Attribute name normalization (keys refer to raw attribute IDs) */
  attributeMapping: AttributeMapping;

  /** Type formatting (mainly for dates) */
  typeMapping?: TypeMapping;

  /** Ignore rules */
  ignore: IgnoreRules;

  /** Value comparison details */
  valueCompare?: ValueCompareOptions;
}

export interface IdMatchingStrategy {
  strategy: 'identifier' | 'attribute' | 'composite';
  attributeName?: string;
  compositeKeys?: string[];
  fallback?: {
    strategy: 'identifier' | 'attribute';
    attributeName?: string;
  };
}

export interface AttributeMapping {
  /**
   * Raw attribute ID -> canonical attribute name.
   * Example: { 'ReqIF.Name': 'Title', 'ReqIF.Text': 'Description' }
   * Attributes not listed here keep their LONG-NAME.
   */
  map: Record<string, string>;
  preferredSource?: 'a' | 'b';
}

export interface TypeMapping {
  [sourceType: string]: {
    targetType: string;
    format?: string;
  };
}

export interface IgnoreRules {
  /** Ignore these raw attribute IDs. */
  attributes?: string[];
  ignoreEmptyVsMissing?: boolean;
}

export interface ValueCompareOptions {
  caseSensitive?: boolean;
  trimWhitespace?: boolean;
  normalizeWhitespace?: boolean;
}

/** Status of a single comparison row. */
export type CompareStatus = 'same' | 'modified' | 'a-only' | 'b-only';

export interface CompareAttrDiff {
  a?: string;
  b?: string;
  same: boolean;
  canonicalKey: string;
}

export interface CompareRow {
  id: string;
  status: CompareStatus;
  title: string;
  typeName?: string;
  attrDiff: Record<string, CompareAttrDiff>;
}

/** Information about a parsed file, used for tool detection. */
export interface ToolDetectionInfo {
  toolId?: string;
  sourceToolId?: string;
  fileName: string;
  /** Raw attribute IDs observed in the file (sample of unique keys). */
  rawAttributeKeys: Set<string>;
}

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface DetectionResult {
  config: AdapterConfig;
  confidence: DetectionConfidence;
  /** Human-readable explanation of why this config was chosen. */
  reason: string;
}