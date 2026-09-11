import { SpecObjectIndex } from '../core/index';
import { AdapterConfig, ValueCompareOptions } from '../adapters/types';

export interface CanonicalObject {
  id: string;
  displayId: string;
  title: string;
  typeName?: string;
  attributes: Record<string, string>;
}

export function normalizeValue(value: string, opts: ValueCompareOptions = {}): string {
  let v = value;
  if (opts.trimWhitespace !== false) v = v.trim();
  if (opts.normalizeWhitespace) v = v.replace(/\s+/g, ' ');
  if (!opts.caseSensitive) v = v.toLowerCase();
  return v;
}

// Apply attribute mapping to produce a canonical attribute map.
//
// Strategy:
//  1. Add every attribute keyed by its LONG-NAME (from `attributes`), which
//     is stable across files that share the same ReqIF type definitions.
//  2. Overlay explicit mappings from `attributeMapping.map` (keyed by raw
//     attribute IDs) to rename a few well-known attributes into canonical
//     names like "Title" or "Description".
//  3. Normalize keys: trim whitespace so that "Title" and "Title " collide
//     into a single column instead of appearing twice.
function applyAttributeMapping(
  obj: SpecObjectIndex,
  config: AdapterConfig
): Record<string, string> {
  const map = config.attributeMapping.map;
  const ignore = new Set(config.ignore.attributes ?? []);
  const result: Record<string, string> = {};

  const attrs = obj.attributes ?? {};
  const raw = obj.rawAttributes ?? {};

  /** Normalize a canonical key: trim, and collapse internal whitespace. */
  const normalizeKey = (key: string) => key.trim().replace(/\s+/g, ' ');

  // Step 1: all attributes by LONG-NAME (normalized).
  for (const [longName, value] of Object.entries(attrs)) {
    if (ignore.has(longName)) continue;
    const canonical = normalizeKey(map[longName] ?? longName);
    if (!canonical) continue;
    if (result[canonical] === undefined) {
      result[canonical] = value;
    }
  }

  // Step 2: apply explicit mappings keyed by raw attribute ID.
  for (const [rawId, value] of Object.entries(raw)) {
    if (ignore.has(rawId)) continue;
    const mapped = map[rawId];
    if (!mapped) continue;
    const canonical = normalizeKey(mapped);
    if (!canonical) continue;

    // Remove the LONG-NAME-based entry that carries the same value,
    // so we don't end up with two keys pointing to the same attribute.
    for (const k of Object.keys(result)) {
      if (k !== canonical && result[k] === value) {
        delete result[k];
        break;
      }
    }
    result[canonical] = value;
  }

  return result;
}

// Extract the ID used for matching from an object.
export function extractMatchId(obj: SpecObjectIndex, config: AdapterConfig): string {
  const strat = config.idMatching;
  const raw = obj.rawAttributes ?? {};
  const attrs = obj.attributes ?? {};

  if (strat.strategy === 'attribute' && strat.attributeName) {
    const v = raw[strat.attributeName] ?? attrs[strat.attributeName];
    if (v) return v;
    if (strat.fallback?.strategy === 'identifier') return obj.id;
    if (strat.fallback?.strategy === 'attribute' && strat.fallback.attributeName) {
      const fb = raw[strat.fallback.attributeName] ?? attrs[strat.fallback.attributeName];
      if (fb) return fb;
    }
    return obj.id;
  }

  if (strat.strategy === 'composite' && strat.compositeKeys?.length) {
    const parts = strat.compositeKeys.map(
      k => raw[k] ?? attrs[k] ?? ''
    );
    if (parts.every(p => p)) return parts.join('::');
    return obj.id;
  }

  return obj.id;
}

// Flatten the tree into a list of canonical objects.
export function canonicalize(
  roots: SpecObjectIndex[],
  config: AdapterConfig
): Map<string, CanonicalObject> {
  const result = new Map<string, CanonicalObject>();

  const traverse = (nodes: SpecObjectIndex[]) => {
    for (const node of nodes) {
      const matchId = extractMatchId(node, config);
      const canonical: CanonicalObject = {
        id: matchId,
        displayId: node.id,
        title: node.title,
        typeName: node.typeName,
        attributes: applyAttributeMapping(node, config),
      };
      if (!result.has(matchId)) {
        result.set(matchId, canonical);
      }
      if (node.children.length > 0) traverse(node.children);
    }
  };
  traverse(roots);
  return result;
}