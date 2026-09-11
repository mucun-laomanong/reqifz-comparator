import { SpecObjectIndex } from '../core/index';
import { AdapterConfig, CompareAttrDiff, CompareRow } from '../adapters/types';
import { canonicalize, normalizeValue, CanonicalObject } from './canonicalize';

function compareAttr(
  key: string,
  a: string | undefined,
  b: string | undefined,
  config: AdapterConfig
): CompareAttrDiff {
  const opts = config.valueCompare ?? {};
  const bothMissing = a === undefined && b === undefined;
  if (bothMissing) {
    return { a, b, same: true, canonicalKey: key };
  }

  const ignoreEmpty = config.ignore.ignoreEmptyVsMissing !== false;
  const aEmpty = a === undefined || a === '';
  const bEmpty = b === undefined || b === '';
  if (ignoreEmpty && (aEmpty || bEmpty)) {
    const onlyOneHas = (aEmpty && !bEmpty) || (!aEmpty && bEmpty);
    if (onlyOneHas) {
      return { a, b, same: true, canonicalKey: key };
    }
  }

  const na = normalizeValue(a ?? '', opts);
  const nb = normalizeValue(b ?? '', opts);
  return { a, b, same: na === nb, canonicalKey: key };
}

export function compareWithAdapter(
  aRoots: SpecObjectIndex[],
  bRoots: SpecObjectIndex[],
  config: AdapterConfig
): CompareRow[] {
  const aMap = canonicalize(aRoots, config);
  const bMap = canonicalize(bRoots, config);

  const allAttrKeys = new Set<string>();
  for (const obj of aMap.values()) {
    Object.keys(obj.attributes).forEach(k => allAttrKeys.add(k));
  }
  for (const obj of bMap.values()) {
    Object.keys(obj.attributes).forEach(k => allAttrKeys.add(k));
  }

  const allIds = new Set<string>([...aMap.keys(), ...bMap.keys()]);
  const rows: CompareRow[] = [];

  for (const id of allIds) {
    const a = aMap.get(id);
    const b = bMap.get(id);

    if (a && !b) {
      rows.push(buildRow(id, 'a-only', a, undefined, allAttrKeys, config));
    } else if (!a && b) {
      rows.push(buildRow(id, 'b-only', undefined, b, allAttrKeys, config));
    } else if (a && b) {
      let allSame = a.title === b.title;
      if (a.typeName !== b.typeName) allSame = false;

      const attrDiff: Record<string, CompareAttrDiff> = {};
      for (const key of allAttrKeys) {
        const diff = compareAttr(key, a.attributes[key], b.attributes[key], config);
        attrDiff[key] = diff;
        if (!diff.same) allSame = false;
      }

      rows.push({
        id,
        status: allSame ? 'same' : 'modified',
        title: a.title || b.title,
        typeName: a.typeName || b.typeName,
        attrDiff,
      });
    }
  }

  rows.sort((x, y) => x.id.localeCompare(y.id));
  return rows;
}

function buildRow(
  id: string,
  status: 'a-only' | 'b-only',
  a: CanonicalObject | undefined,
  b: CanonicalObject | undefined,
  allAttrKeys: Set<string>,
  config: AdapterConfig
): CompareRow {
  const attrDiff: Record<string, CompareAttrDiff> = {};
  for (const key of allAttrKeys) {
    attrDiff[key] = compareAttr(key, a?.attributes[key], b?.attributes[key], config);
  }
  return {
    id,
    status,
    title: a?.title || b?.title || '',
    typeName: a?.typeName || b?.typeName,
    attrDiff,
  };
}