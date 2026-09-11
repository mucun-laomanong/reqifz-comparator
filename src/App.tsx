import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useDeferredValue,
  memo,
  startTransition,
} from 'react';
import ParseWorker from './workers/parse.worker?worker';
import {
  SpecObjectIndex,
  CachedSpecObject,
  CachedIndex,
  ParsedReqif,
  CACHE_VERSION,
} from './core/index';
import { Virtuoso } from 'react-virtuoso';
import { save } from '@tauri-apps/plugin-dialog';
import {
  writeTextFile,
  readTextFile,
  exists,
  mkdir,
  remove,
  readDir,
  BaseDirectory,
} from '@tauri-apps/plugin-fs';
import { detectAdapter } from './adapters/registry';
import { compareWithAdapter } from './compare/compare';
import type {
  CompareAttrDiff,
  CompareRow,
  CompareStatus,
  ToolDetectionInfo,
  DetectionResult,
} from './adapters/types';
import './doors-theme.css';

interface NodeEntry {
  node: SpecObjectIndex;
  depth: number;
}

interface FilterOption {
  value: string;
  count: number;
}

const CACHE_DIR = 'reqif-cache';
const PREFS_FILE_NAME = 'column-prefs.json';
const PREFS_FILE = `${CACHE_DIR}/${PREFS_FILE_NAME}`;
const DEFAULT_DETAIL_HEIGHT = 260;
const ROW_HEIGHT = 23;

/** Default widths for special columns. */
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  __title__: 300,
  __id__: 150,
  __status__: 90,
  __cmp_title__: 220,
  __cmp_id__: 100,
};
const DEFAULT_ATTR_COL_WIDTH = 180;
const MIN_COL_WIDTH = 60;
const EXPAND_COL_WIDTH = 30;
const SCROLLBAR_WIDTH = 16;
const COMPARE_TREE_COL_WIDTH = 28;
/** Width of the fixed vertical divider between the two comparison panels. */
const COMPARE_DIVIDER_WIDTH = 4;

interface ColumnPrefs {
  [fileName: string]: string[];
}

const labelCellStyle: React.CSSProperties = {
  padding: '2px 12px 2px 0',
  verticalAlign: 'top',
  color: '#333',
  fontWeight: 'bold',
  whiteSpace: 'nowrap',
  width: '140px',
  fontSize: '12px',
};
const valueCellStyle: React.CSSProperties = {
  padding: '2px 0',
  verticalAlign: 'top',
  color: '#000',
  fontSize: '12px',
};

const compareRowBg = (s: CompareStatus): string => {
  switch (s) {
    case 'same': return '#ffffff';
    case 'modified': return '#fffbe6';
    case 'a-only': return '#eaf2ff';
    case 'b-only': return '#eaffef';
  }
};

const renderStatusBadge = (status: CompareStatus) => {
  const map: Record<CompareStatus, { text: string; color: string; bg: string }> = {
    same: { text: 'Same', color: '#555', bg: '#e0e0e0' },
    modified: { text: 'Modified', color: '#7a4200', bg: '#ffd88a' },
    'a-only': { text: 'A-only', color: '#0d3a7a', bg: '#c8ddff' },
    'b-only': { text: 'B-only', color: '#145a2b', bg: '#bdebc7' },
  };
  const s = map[status];
  return (
    <span
      className="doors-badge"
      style={{ color: s.color, background: s.bg, border: '1px solid ' + s.color }}
    >
      {s.text}
    </span>
  );
};

function hashString(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function serializeIndexes(parsed: ParsedReqif): CachedIndex {
  const objects: CachedSpecObject[] = [];
  const rootIds: string[] = [];
  const traverse = (nodes: SpecObjectIndex[], isRoot: boolean) => {
    nodes.forEach(node => {
      const childrenIds = node.children.map(c => c.id);
      objects.push({
        id: node.id,
        title: node.title,
        offset: node.offset,
        length: node.length,
        hierarchyPath: node.hierarchyPath,
        attributes: node.attributes,
        rawAttributes: node.rawAttributes,
        typeRef: node.typeRef,
        typeName: node.typeName,
        childrenIds,
      });
      if (isRoot) rootIds.push(node.id);
      traverse(node.children, false);
    });
  };
  traverse(parsed.indexes, true);
  return { objects, rootIds, toolId: parsed.toolId, sourceToolId: parsed.sourceToolId };
}

function deserializeIndexes(cached: CachedIndex): SpecObjectIndex[] {
  const map = new Map<string, SpecObjectIndex>();
  for (const o of cached.objects) {
    map.set(o.id, {
      id: o.id, title: o.title, offset: o.offset, length: o.length,
      hierarchyPath: o.hierarchyPath, attributes: o.attributes,
      rawAttributes: o.rawAttributes, typeRef: o.typeRef, typeName: o.typeName,
      children: [],
    });
  }
  for (const o of cached.objects) {
    const node = map.get(o.id);
    if (!node) continue;
    for (const cid of o.childrenIds) {
      const child = map.get(cid);
      if (child) node.children.push(child);
    }
  }
  return cached.rootIds.map(id => map.get(id)).filter(Boolean) as SpecObjectIndex[];
}

function countTotal(nodes: SpecObjectIndex[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.children && node.children.length > 0) n += countTotal(node.children);
  }
  return n;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let idx = text.toLowerCase().indexOf(lower, lastIndex);
  let key = 0;
  while (idx >= 0) {
    if (idx > lastIndex) parts.push(text.slice(lastIndex, idx));
    parts.push(<mark key={key++}>{text.slice(idx, idx + query.length)}</mark>);
    lastIndex = idx + query.length;
    idx = text.toLowerCase().indexOf(lower, lastIndex);
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

function escapeCsv(value: string | undefined | null): string {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function applyColumnOverrides(
  rows: CompareRow[],
  bRename: Record<string, string>,
  ignored: Set<string>
): CompareRow[] {
  const hasRename = Object.keys(bRename).length > 0;
  if (!hasRename && ignored.size === 0) return rows;

  return rows.map(row => {
    const newDiff: Record<string, CompareAttrDiff> = {};
    for (const [key, d] of Object.entries(row.attrDiff)) {
      const targetKey = bRename[key] ?? key;
      if (ignored.has(key) || ignored.has(targetKey)) continue;

      const existing = newDiff[targetKey];
      if (existing) {
        if (d.a !== undefined && existing.a === undefined) existing.a = d.a;
        if (d.b !== undefined && existing.b === undefined) existing.b = d.b;
        existing.same = (existing.a ?? '') === (existing.b ?? '');
      } else {
        newDiff[targetKey] = { a: d.a, b: d.b, same: d.same, canonicalKey: targetKey };
      }
    }
    return { ...row, attrDiff: newDiff };
  });
}

function mergeCompareRows(a: CompareRow, b: CompareRow): CompareRow {
  const keys = new Set<string>([
    ...Object.keys(a.attrDiff),
    ...Object.keys(b.attrDiff),
  ]);
  const newDiff: Record<string, CompareAttrDiff> = {};
  let anyDiff = false;
  for (const k of keys) {
    const da = a.attrDiff[k];
    const db = b.attrDiff[k];
    const aVal = da ? (da.a ?? da.b) : undefined;
    const bVal = db ? (db.b ?? db.a) : undefined;
    const same = (aVal ?? '') === (bVal ?? '');
    if (!same) anyDiff = true;
    newDiff[k] = {
      a: aVal,
      b: bVal,
      same,
      canonicalKey: k,
    };
  }
  return {
    id: a.id,
    title: a.title || b.title,
    status: anyDiff ? 'modified' : 'same',
    attrDiff: newDiff,
  };
}

function rematchByTitle(rawCompareData: CompareRow[]): {
  rematchedData: CompareRow[];
  bIdForMerged: Map<string, string>;
  hiddenBIds: Set<string>;
} {
  const aOnly: CompareRow[] = [];
  const bOnly: CompareRow[] = [];
  for (const r of rawCompareData) {
    if (r.status === 'a-only') aOnly.push(r);
    else if (r.status === 'b-only') bOnly.push(r);
  }
  if (aOnly.length === 0 || bOnly.length === 0) {
    return { rematchedData: rawCompareData, bIdForMerged: new Map(), hiddenBIds: new Set() };
  }

  const bByKey = new Map<string, CompareRow[]>();
  for (const r of bOnly) {
    const k = r.title ?? '';
    if (!bByKey.has(k)) bByKey.set(k, []);
    bByKey.get(k)!.push(r);
  }

  const bIdForMerged = new Map<string, string>();
  const hiddenBIds = new Set<string>();
  const replacement = new Map<string, CompareRow>();

  for (const ar of aOnly) {
    const k = ar.title ?? '';
    const list = bByKey.get(k);
    if (list && list.length > 0) {
      const br = list.shift()!;
      bIdForMerged.set(ar.id, br.id);
      hiddenBIds.add(br.id);
      replacement.set(ar.id, mergeCompareRows(ar, br));
    }
  }

  const result: CompareRow[] = [];
  for (const r of rawCompareData) {
    if (hiddenBIds.has(r.id)) continue;
    result.push(replacement.get(r.id) ?? r);
  }

  return { rematchedData: result, bIdForMerged, hiddenBIds };
}

// ============== Normal-mode Tree row ==============

interface TreeRowProps {
  node: SpecObjectIndex;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  isMatched: boolean;
  searchText: string;
  visibleColumnList: string[];
  columnWidths: Record<string, number>;
  onRowClick: (id: string) => void;
  onToggleExpand: (id: string) => void;
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  hasChildren,
  isExpanded,
  isSelected,
  isMatched,
  searchText,
  visibleColumnList,
  columnWidths,
  onRowClick,
  onToggleExpand,
}: TreeRowProps) {
  const titleW = columnWidths.__title__ ?? DEFAULT_COL_WIDTHS.__title__;
  const idW = columnWidths.__id__ ?? DEFAULT_COL_WIDTHS.__id__;

  return (
    <div
      className={
        'doors-row' +
        (isSelected ? ' selected' : '') +
        (isMatched ? ' matched' : '')
      }
      onClick={() => onRowClick(node.id)}
    >
      <span
        className="doors-tree-toggle"
        style={{ width: EXPAND_COL_WIDTH, flexShrink: 0 }}
        onClick={(e) => {
          if (hasChildren) {
            e.stopPropagation();
            onToggleExpand(node.id);
          }
        }}
      >
        {hasChildren ? (isExpanded ? '⊟' : '⊞') : ''}
      </span>
      <span
        className="doors-td"
        style={{
          width: titleW, flexShrink: 0,
          paddingLeft: 6 + depth * 16,
          boxSizing: 'border-box',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {highlightText(node.title, searchText)}
      </span>
      <span className="doors-td" style={{ width: idW, flexShrink: 0 }}>
        {highlightText(node.id, searchText)}
      </span>
      {visibleColumnList.map(key => {
        const w = columnWidths[key] ?? DEFAULT_ATTR_COL_WIDTH;
        return (
          <span key={key} className="doors-td" style={{ width: w, flexShrink: 0 }}>
            {highlightText(node.attributes?.[key] ?? '', searchText)}
          </span>
        );
      })}
      <span style={{ flex: 1 }} />
    </div>
  );
});

// ============== Compare-mode Left / Right rows ==============

interface CompareLeftRowProps {
  id: string;
  entryA: NodeEntry | undefined;
  row: CompareRow | undefined;
  status: CompareStatus;
  isSelected: boolean;
  expandedA: boolean;
  titleColumnA: string;
  hideIdColumn: boolean;
  attrColumns: string[];
  cmpTitleWidth: number;
  cmpIdWidth: number;
  columnWidths: Record<string, number>;
  totalWidth: number;
  extraWidth: number; // 新增：额外填补的宽度
  onRowClick: (id: string) => void;
  onToggleA: (id: string) => void;
}

const CompareLeftRow = memo(function CompareLeftRow({
  id, entryA, row, status, isSelected, expandedA,
  titleColumnA, hideIdColumn, attrColumns,
  cmpTitleWidth, cmpIdWidth, columnWidths,
  totalWidth, extraWidth,
  onRowClick, onToggleA,
}: CompareLeftRowProps) {
  const bg = isSelected ? undefined : compareRowBg(status);
  const aNode = entryA?.node;
  const aDepth = entryA?.depth ?? 0;
  const aHasChildren = !!aNode && aNode.children.length > 0;

  const aTitle = titleColumnA
    ? (aNode?.attributes?.[titleColumnA] ?? aNode?.title ?? '')
    : (aNode?.title ?? '');

  const cellBaseStyle: React.CSSProperties = {
    flexShrink: 0,
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const hasAttrs = attrColumns.length > 0;

  return (
    <div
      className={'doors-row' + (isSelected ? ' selected' : '')}
      style={{
        background: bg,
        display: 'flex',
        alignItems: 'stretch',
        minHeight: ROW_HEIGHT,
        width: totalWidth,
      }}
      onClick={() => onRowClick(id)}
    >
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div
          className="doors-td"
          style={{ ...cellBaseStyle, width: cmpTitleWidth, paddingLeft: 6 + aDepth * 12 }}
          title={aTitle}
        >
          {aTitle}
        </div>
        {!hideIdColumn && (
          <div
            className="doors-td"
            style={{ 
              ...cellBaseStyle, 
              width: (!hasAttrs ? cmpIdWidth + extraWidth : cmpIdWidth), // 如果没有属性列，额外宽度给 ID 列
              color: '#777', 
              fontSize: '11px' 
            }}
            title={aNode?.id}
          >
            {aNode?.id ?? ''}
          </div>
        )}
        {attrColumns.map((k, idx) => {
          const w = columnWidths[k] ?? DEFAULT_ATTR_COL_WIDTH;
          const isLast = idx === attrColumns.length - 1;
          // 如果是最后一列，加上额外的填充宽度
          const finalW = isLast ? w + extraWidth : w;
          
          const d = row?.attrDiff[k];
          const val = d?.a ?? '';
          const differs = !!d && !d.same;
          return (
            <div
              key={'a_' + k}
              className="doors-td"
              style={{
                ...cellBaseStyle,
                width: finalW,
                background: differs ? '#ffe2e2' : undefined,
              }}
              title={val}
            >
              {val}
            </div>
          );
        })}
      </div>

      {/* 固定在右侧的树列 (Sticky) */}
      <div
        className="doors-td"
        style={{
          marginLeft: 'auto',
          position: 'sticky',
          right: 0,
          width: COMPARE_TREE_COL_WIDTH,
          flexShrink: 0,
          padding: 0,
          textAlign: 'center',
          background: '#f5f4ea',
          zIndex: 10,
          borderLeft: '1px solid #d0d0d0',
          fontSize: '13px',
          fontFamily: '"MS Gothic", "SimSun", monospace',
          lineHeight: 1,
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: aHasChildren ? '#333' : 'transparent',
          cursor: aHasChildren ? 'pointer' : 'default',
        }}
        onClick={(e) => {
          if (aHasChildren && aNode) { e.stopPropagation(); onToggleA(aNode.id); }
        }}
        title={aNode?.id ?? ''}
      >
        {aHasChildren ? (expandedA ? '日' : '田') : ''}
      </div>
    </div>
  );
});

interface CompareRightRowProps {
  id: string;
  entryB: NodeEntry | undefined;
  row: CompareRow | undefined;
  status: CompareStatus;
  isSelected: boolean;
  expandedB: boolean;
  titleColumnB: string;
  hideIdColumn: boolean;
  attrColumns: string[];
  cmpTitleWidth: number;
  cmpIdWidth: number;
  columnWidths: Record<string, number>;
  totalWidth: number;
  extraWidth: number; // 新增：额外填补的宽度
  onRowClick: (id: string) => void;
  onToggleB: (id: string) => void;
}

const CompareRightRow = memo(function CompareRightRow({
  id, entryB, row, status, isSelected, expandedB,
  titleColumnB, hideIdColumn, attrColumns,
  cmpTitleWidth, cmpIdWidth, columnWidths,
  totalWidth, extraWidth,
  onRowClick, onToggleB,
}: CompareRightRowProps) {
  const bg = isSelected ? undefined : compareRowBg(status);
  const bNode = entryB?.node;
  const bDepth = entryB?.depth ?? 0;
  const bHasChildren = !!bNode && bNode.children.length > 0;

  const bTitle = titleColumnB
    ? (bNode?.attributes?.[titleColumnB] ?? bNode?.title ?? '')
    : (bNode?.title ?? '');

  const cellBaseStyle: React.CSSProperties = {
    flexShrink: 0,
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const hasAttrs = attrColumns.length > 0;

  return (
    <div
      className={'doors-row' + (isSelected ? ' selected' : '')}
      style={{
        background: bg,
        display: 'flex',
        alignItems: 'stretch',
        minHeight: ROW_HEIGHT,
        width: totalWidth,
      }}
      onClick={() => onRowClick(id)}
    >
      {/* 固定在左侧的树列 (Sticky) */}
      <div
        className="doors-td"
        style={{
          position: 'sticky',
          left: 0,
          width: COMPARE_TREE_COL_WIDTH,
          flexShrink: 0,
          padding: 0,
          textAlign: 'center',
          background: '#f5f4ea',
          zIndex: 10,
          borderRight: '1px solid #d0d0d0',
          fontSize: '13px',
          fontFamily: '"MS Gothic", "SimSun", monospace',
          lineHeight: 1,
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: bHasChildren ? '#333' : 'transparent',
          cursor: bHasChildren ? 'pointer' : 'default',
        }}
        onClick={(e) => {
          if (bHasChildren && bNode) { e.stopPropagation(); onToggleB(bNode.id); }
        }}
        title={bNode?.id ?? ''}
      >
        {bHasChildren ? (expandedB ? '日' : '田') : ''}
      </div>

      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div
          className="doors-td"
          style={{ ...cellBaseStyle, width: cmpTitleWidth, paddingLeft: 6 + bDepth * 12 }}
          title={bTitle}
        >
          {bTitle}
        </div>
        {!hideIdColumn && (
          <div
            className="doors-td"
            style={{ 
              ...cellBaseStyle, 
              width: (!hasAttrs ? cmpIdWidth + extraWidth : cmpIdWidth),
              color: '#777', 
              fontSize: '11px' 
            }}
            title={bNode?.id}
          >
            {bNode?.id ?? ''}
          </div>
        )}
        {attrColumns.map((k, idx) => {
          const w = columnWidths[k] ?? DEFAULT_ATTR_COL_WIDTH;
          const isLast = idx === attrColumns.length - 1;
          const finalW = isLast ? w + extraWidth : w;
          
          const d = row?.attrDiff[k];
          const val = d?.b ?? '';
          const differs = !!d && !d.same;
          return (
            <div
              key={'b_' + k}
              className="doors-td"
              style={{
                ...cellBaseStyle,
                width: finalW,
                background: differs ? '#dcf5e3' : undefined,
              }}
              title={val}
            >
              {val}
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ============== Column mapping panel ==============

interface ColumnMappingPanelProps {
  keys: string[];
  sources: Record<string, { a: boolean; b: boolean }>;
  initialBRename: Record<string, string>;
  initialIgnored: Set<string>;
  initialTitleColumnA: string;
  initialTitleColumnB: string;
  initialIgnoreId: boolean;
  onApply: (
    bRename: Record<string, string>,
    ignored: Set<string>,
    titleColumnA: string,
    titleColumnB: string,
    ignoreId: boolean
  ) => void;
  onClose: () => void;
}

function ColumnMappingPanel({
  keys, sources, initialBRename, initialIgnored,
  initialTitleColumnA, initialTitleColumnB,
  initialIgnoreId,
  onApply, onClose,
}: ColumnMappingPanelProps) {
  const [bRename, setBRename] = useState<Record<string, string>>({ ...initialBRename });
  const [ignored, setIgnored] = useState<Set<string>>(new Set(initialIgnored));
  const [titleColumnA, setTitleColumnA] = useState<string>(initialTitleColumnA);
  const [titleColumnB, setTitleColumnB] = useState<string>(initialTitleColumnB);
  const [ignoreId, setIgnoreId] = useState<boolean>(initialIgnoreId);

  const toggleIgnore = (k: string) => {
    setIgnored(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const setRename = (k: string, value: string) => {
    setBRename(prev => {
      const next = { ...prev };
      const trimmed = value.trim();
      if (trimmed && trimmed !== k) next[k] = trimmed;
      else delete next[k];
      return next;
    });
  };

  const handleReset = () => {
    setBRename({});
    setIgnored(new Set());
    setTitleColumnA('');
    setTitleColumnB('');
    setIgnoreId(false);
  };

  const renamedInto = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [src, tgt] of Object.entries(bRename)) {
      if (!m.has(tgt)) m.set(tgt, []);
      m.get(tgt)!.push(src);
    }
    return m;
  }, [bRename]);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.35)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 10000,
    }}>
      <div style={{
        width: '820px', maxHeight: '85vh',
        display: 'flex', flexDirection: 'column',
        background: '#f0efe4', border: '2px solid #808080',
        boxShadow: '4px 4px 12px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          padding: '6px 10px',
          background: 'linear-gradient(to bottom, #f8f7f0, #d8d4c8)',
          borderBottom: '1px solid #808080',
          fontWeight: 'bold', fontSize: '12px',
        }}>
          Column Mapping
        </div>

        <div style={{
          padding: '8px 10px',
          fontSize: '11px', color: '#333',
          borderBottom: '1px solid #d0d0d0',
          background: '#faf9f0',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          <div style={{ fontWeight: 'bold' }}>Title column (which attribute is shown as the row title)</div>
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              File A:
              <select
                value={titleColumnA}
                onChange={(e) => setTitleColumnA(e.target.value)}
                style={{
                  padding: '1px 4px',
                  fontSize: '11px',
                  fontFamily: 'inherit',
                  border: '1px solid #b8b4a8',
                  minWidth: '200px',
                }}
              >
                <option value="">(auto — parser's guess)</option>
                {keys.map(k => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              File B:
              <select
                value={titleColumnB}
                onChange={(e) => setTitleColumnB(e.target.value)}
                style={{
                  padding: '1px 4px',
                  fontSize: '11px',
                  fontFamily: 'inherit',
                  border: '1px solid #b8b4a8',
                  minWidth: '200px',
                }}
              >
                <option value="">(auto — parser's guess)</option>
                {keys.map(k => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div style={{
          padding: '8px 10px',
          fontSize: '11px', color: '#333',
          borderBottom: '1px solid #d0d0d0',
          background: '#faf9f0',
        }}>
          <label style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
            cursor: 'pointer',
            lineHeight: 1.4,
          }}>
            <input
              type="checkbox"
              checked={ignoreId}
              onChange={(e) => setIgnoreId(e.target.checked)}
              style={{ marginTop: '2px' }}
            />
            <span>
              <b>Match rows by content instead of ID.</b>{' '}
              When enabled, rows that appear on only one side will be
              re-paired with same-titled rows from the other side
              (in document order) so that attributes can actually be
              compared across files whose <code>ReqIf.ID</code> values
              differ. The ID column will also be hidden.
              <br />
              This is the right option when comparing files whose
              identifiers were regenerated but whose content corresponds.
            </span>
          </label>
        </div>

        <div style={{
          padding: '8px 10px',
          fontSize: '11px', color: '#555',
          borderBottom: '1px solid #d0d0d0',
        }}>
          Check <b>Ignore</b> to exclude an attribute from comparison.
          Use the <b>Rename to</b> dropdown to align an attribute from one side
          with the attribute from the other side.
          For example, if file A has <code>ReqIf.Text</code> and file B has{' '}
          <code>ReqIf.ChapterName</code>, pick <code>ReqIf.Text</code> in the{' '}
          <code>ReqIf.ChapterName</code> row's dropdown to merge them into one column.
        </div>
        <div style={{
          flex: 1, overflow: 'auto', padding: '4px 10px', background: '#ffffff',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: '#f5f4ea' }}>
                <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #d0d0d0', width: '60px' }}>Ignore</th>
                <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #d0d0d0' }}>Attribute</th>
                <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #d0d0d0', width: '60px' }}>Source</th>
                <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #d0d0d0', width: '280px' }}>Rename to</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => {
                const src = sources[k] ?? { a: false, b: false };
                const srcLabel = src.a && src.b ? 'A+B' : src.a ? 'A' : 'B';
                const currentTarget = bRename[k] ?? '';
                const sourcesMergedHere = renamedInto.get(k) ?? [];
                const isRenamed = currentTarget !== '';
                const isMergedTarget = sourcesMergedHere.length > 0;
                return (
                  <tr
                    key={k}
                    style={{
                      borderBottom: '1px solid #eee',
                      background: isRenamed
                        ? '#fffbe6'
                        : isMergedTarget
                        ? '#eef7ff'
                        : undefined,
                    }}
                  >
                    <td style={{ padding: '2px 6px' }}>
                      <input
                        type="checkbox"
                        checked={ignored.has(k)}
                        onChange={() => toggleIgnore(k)}
                      />
                    </td>
                    <td
                      style={{
                        padding: '2px 6px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        opacity: ignored.has(k) ? 0.5 : 1,
                        fontWeight: isMergedTarget ? 'bold' : 'normal',
                      }}
                      title={k}
                    >
                      {k}
                      {isMergedTarget && (
                        <span style={{ color: '#0a246a', fontSize: '10px', marginLeft: '6px' }}>
                          ← {sourcesMergedHere.join(', ')}
                        </span>
                      )}
                    </td>
                    <td style={{
                      padding: '2px 6px',
                      color: '#666',
                      opacity: ignored.has(k) ? 0.5 : 1,
                    }}>
                      {srcLabel}
                    </td>
                    <td style={{ padding: '2px 6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <select
                          value={currentTarget}
                          onChange={(e) => setRename(k, e.target.value)}
                          disabled={ignored.has(k)}
                          style={{
                            flex: 1,
                            boxSizing: 'border-box',
                            padding: '1px 4px',
                            fontSize: '11px',
                            fontFamily: 'inherit',
                            border: '1px solid #b8b4a8',
                            background: '#ffffff',
                            cursor: ignored.has(k) ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <option value="">(keep as-is)</option>
                          {keys
                            .filter(other => other !== k)
                            .map(other => (
                              <option key={other} value={other}>
                                {other}
                              </option>
                            ))}
                        </select>
                        {isRenamed && (
                          <span
                            style={{
                              color: '#7a4200',
                              fontSize: '11px',
                              whiteSpace: 'nowrap',
                            }}
                            title={`${k} will be merged into ${currentTarget}`}
                          >
                            → {currentTarget}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {keys.length === 0 && (
                <tr><td colSpan={4} style={{ padding: '10px', color: '#888', textAlign: 'center' }}>
                  No attributes found in the comparison.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{
          padding: '6px 10px',
          borderTop: '1px solid #808080',
          background: 'linear-gradient(to bottom, #f0efe4, #e0dcd0)',
          display: 'flex', justifyContent: 'flex-end', gap: '6px',
        }}>
          <button className="doors-btn" onClick={handleReset}>Reset</button>
          <button className="doors-btn" onClick={onClose}>Cancel</button>
          <button
            className="doors-btn"
            style={{ background: 'linear-gradient(to bottom, #fff5d5, #f0e2a8)' }}
            onClick={() => {
              onApply(bRename, ignored, titleColumnA, titleColumnB, ignoreId);
              onClose();
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ============== Main component ==============

export default function App() {
  const [rootData, setRootData] = useState<SpecObjectIndex[]>([]);
  const [bRootData, setBRootData] = useState<SpecObjectIndex[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [expandedNodesB, setExpandedNodesB] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const deferredSearchText = useDeferredValue(searchText);
  const [matchedIds, setMatchedIds] = useState<Set<string>>(new Set());
  const [ancestorIds, setAncestorIds] = useState<Set<string>>(new Set());
  const [currentFileName, setCurrentFileName] = useState<string>('');

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set());
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const columnPanelRef = useRef<HTMLDivElement | null>(null);

  const [columnFilters, setColumnFilters] = useState<Record<string, Set<string>>>({});
  const [openFilterColumn, setOpenFilterColumn] = useState<string | null>(null);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);
  const [filterPanelPos, setFilterPanelPos] = useState<{ top: number; left: number } | null>(null);

  // Column widths (in-memory only)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const colResizeRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const prefsRef = useRef<ColumnPrefs>({});
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Raw comparison result and manual overrides
  const [rawCompareData, setRawCompareData] = useState<CompareRow[] | null>(null);
  const [bRename, setBRename] = useState<Record<string, string>>({});
  const [ignoredAttrs, setIgnoredAttrs] = useState<Set<string>>(new Set());
  const [titleColumnA, setTitleColumnA] = useState<string>('');
  const [titleColumnB, setTitleColumnB] = useState<string>('');
  const [mappingPanelOpen, setMappingPanelOpen] = useState(false);
  const [ignoreIdColumn, setIgnoreIdColumn] = useState<boolean>(false);

  // Rematch pass (only active when ignoreIdColumn is on).
  const { rematchedData, bIdForMerged, hiddenBIds } = useMemo(() => {
    if (!rawCompareData || !ignoreIdColumn) {
      return {
        rematchedData: rawCompareData,
        bIdForMerged: new Map<string, string>(),
        hiddenBIds: new Set<string>(),
      };
    }
    return rematchByTitle(rawCompareData);
  }, [rawCompareData, ignoreIdColumn]);

  const compareData: CompareRow[] | null = useMemo(() => {
    if (!rematchedData) return null;
    return applyColumnOverrides(rematchedData, bRename, ignoredAttrs);
  }, [rematchedData, bRename, ignoredAttrs]);

  const [compareFileName, setCompareFileName] = useState<string>('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const compareInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [currentToolInfo, setCurrentToolInfo] = useState<ToolDetectionInfo | null>(null);
  const [lastDetection, setLastDetection] = useState<DetectionResult | null>(null);

  const isCompareMode = compareData !== null;

  const [detailHeight, setDetailHeight] = useState<number>(DEFAULT_DETAIL_HEIGHT);
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [statusType, setStatusType] = useState<'info' | 'success' | 'error'>('info');

  // === Compare-view scroll infrastructure ===
  const leftHeaderContentRef = useRef<HTMLDivElement | null>(null);
  const rightHeaderContentRef = useRef<HTMLDivElement | null>(null);
  const leftScrollerRef = useRef<HTMLElement | null>(null);
  const rightScrollerRef = useRef<HTMLElement | null>(null);

  // === 监听左右面板的宽度，用于自动填满剩余空间 ===
  const leftPanelRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState(0);
  const [rightPanelWidth, setRightPanelWidth] = useState(0);

  useEffect(() => {
    if (!isCompareMode) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === leftPanelRef.current) setLeftPanelWidth(entry.contentRect.width);
        if (entry.target === rightPanelRef.current) setRightPanelWidth(entry.contentRect.width);
      }
    });
    if (leftPanelRef.current) observer.observe(leftPanelRef.current);
    if (rightPanelRef.current) observer.observe(rightPanelRef.current);
    return () => observer.disconnect();
  }, [isCompareMode]);

  const setStatus = useCallback(
    (msg: string, type: 'info' | 'success' | 'error' = 'info') => {
      setStatusMessage(msg);
      setStatusType(type);
    },
    []
  );

  const applyData = useCallback(
    (
      indexes: SpecObjectIndex[],
      message: string,
      resetExpanded: boolean = true,
      type: 'info' | 'success' | 'error' = 'success'
    ) => {
      setRootData(indexes);
      if (resetExpanded) {
        const allExpandableIds = new Set<string>();
        const collectIds = (nodes: SpecObjectIndex[]) => {
          nodes.forEach(node => {
            if (node.children.length > 0) {
              allExpandableIds.add(node.id);
              collectIds(node.children);
            }
          });
        };
        collectIds(indexes);
        setExpandedNodes(allExpandableIds);
      }
      const total = countTotal(indexes);
      setStatus(`${message} (${total} requirements)`, type);
    },
    [setStatus]
  );

  const buildToolInfo = useCallback(
    (fileName: string, roots: SpecObjectIndex[], toolId?: string, sourceToolId?: string): ToolDetectionInfo => {
      const keys = new Set<string>();
      const traverse = (nodes: SpecObjectIndex[]) => {
        for (const n of nodes) {
          if (n.rawAttributes) {
            for (const k of Object.keys(n.rawAttributes)) {
              keys.add(k);
              if (keys.size >= 200) return;
            }
          }
          if (n.children.length > 0 && keys.size < 200) traverse(n.children);
        }
      };
      traverse(roots);
      return { fileName, toolId, sourceToolId, rawAttributeKeys: keys };
    },
    []
  );

  // ===== Column width management =====
  const getColumnWidth = useCallback(
    (key: string): number => {
      if (columnWidths[key] !== undefined) return columnWidths[key];
      if (DEFAULT_COL_WIDTHS[key] !== undefined) return DEFAULT_COL_WIDTHS[key];
      return DEFAULT_ATTR_COL_WIDTH;
    },
    [columnWidths]
  );

  const startColumnResize = useCallback(
    (e: React.MouseEvent, key: string) => {
      e.preventDefault();
      e.stopPropagation();
      const currentWidth = getColumnWidth(key);
      colResizeRef.current = { key, startX: e.clientX, startWidth: currentWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [getColumnWidth]
  );

  const resetColumnWidth = useCallback((key: string) => {
    setColumnWidths(prev => {
      if (prev[key] === undefined) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const r = colResizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const newWidth = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths(prev => ({ ...prev, [r.key]: newWidth }));
    };
    const handleUp = () => {
      if (colResizeRef.current) {
        colResizeRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, []);

  // ===== Node lookup tables =====
  const nodeMap = useMemo(() => {
    const map = new Map<string, NodeEntry>();
    const traverse = (nodes: SpecObjectIndex[], depth: number) => {
      for (const n of nodes) {
        map.set(n.id, { node: n, depth });
        if (n.children.length > 0) traverse(n.children, depth + 1);
      }
    };
    traverse(rootData, 0);
    return map;
  }, [rootData]);

  const bNodeMap = useMemo(() => {
    const map = new Map<string, NodeEntry>();
    const traverse = (nodes: SpecObjectIndex[], depth: number) => {
      for (const n of nodes) {
        map.set(n.id, { node: n, depth });
        if (n.children.length > 0) traverse(n.children, depth + 1);
      }
    };
    traverse(bRootData, 0);
    return map;
  }, [bRootData]);

  // ===== Flattened id lists =====
  const displayRowIds = useMemo(() => {
    const result: string[] = [];
    const traverse = (nodes: SpecObjectIndex[], expanded: Set<string>) => {
      for (const n of nodes) {
        result.push(n.id);
        if (n.children.length > 0 && expanded.has(n.id)) traverse(n.children, expanded);
      }
    };
    traverse(rootData, expandedNodes);
    return result;
  }, [rootData, expandedNodes]);

  const bDisplayRowIds = useMemo(() => {
    const result: string[] = [];
    const traverse = (nodes: SpecObjectIndex[], expanded: Set<string>) => {
      for (const n of nodes) {
        result.push(n.id);
        if (n.children.length > 0 && expanded.has(n.id)) traverse(n.children, expanded);
      }
    };
    traverse(bRootData, expandedNodesB);
    return result;
  }, [bRootData, expandedNodesB]);

  const statusByIdMap = useMemo(() => {
    const m = new Map<string, CompareStatus>();
    if (compareData) {
      for (const r of compareData) m.set(r.id, r.status);
    }
    return m;
  }, [compareData]);

  const compareRowById = useMemo(() => {
    const m = new Map<string, CompareRow>();
    if (compareData) {
      for (const r of compareData) m.set(r.id, r);
    }
    return m;
  }, [compareData]);

  const compareDisplayIds = useMemo(() => {
    if (!isCompareMode) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of displayRowIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    for (const id of bDisplayRowIds) {
      if (hiddenBIds.has(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    if (onlyDiff) {
      return result.filter(id => statusByIdMap.get(id) !== 'same');
    }
    return result;
  }, [isCompareMode, displayRowIds, bDisplayRowIds, onlyDiff, statusByIdMap, hiddenBIds]);

  const attributeColumns = useMemo(() => {
    const keys = new Set<string>();
    const collectKeys = (nodes: SpecObjectIndex[]) => {
      for (const node of nodes) {
        if (node.attributes) {
          for (const k of Object.keys(node.attributes)) keys.add(k);
        }
        if (node.children.length > 0) collectKeys(node.children);
      }
    };
    collectKeys(rootData);
    return Array.from(keys).sort();
  }, [rootData]);

  const visibleColumnList = useMemo(
    () => attributeColumns.filter(c => visibleColumns.has(c)),
    [attributeColumns, visibleColumns]
  );

  const compareAttributeColumns = useMemo(() => {
    if (!compareData) return [];
    const RESERVED = new Set(['Title', 'Status']);
    const keys = new Set<string>();
    for (const row of compareData) {
      for (const k of Object.keys(row.attrDiff)) {
        if (!RESERVED.has(k)) keys.add(k);
      }
    }
    return Array.from(keys).sort();
  }, [compareData]);

  const compareVisibleAttrColumns = useMemo(() => {
    return compareAttributeColumns.filter(k => k !== titleColumnA && k !== titleColumnB);
  }, [compareAttributeColumns, titleColumnA, titleColumnB]);

  const effectiveColumnList = useMemo(
    () => (isCompareMode ? compareAttributeColumns : visibleColumnList),
    [isCompareMode, compareAttributeColumns, visibleColumnList]
  );

  const rawAttributeKeys = useMemo(() => {
    if (!rematchedData) return { keys: [] as string[], sources: {} as Record<string, { a: boolean; b: boolean }> };
    const sources: Record<string, { a: boolean; b: boolean }> = {};
    const keys = new Set<string>();
    for (const row of rematchedData) {
      for (const [k, d] of Object.entries(row.attrDiff)) {
        keys.add(k);
        if (!sources[k]) sources[k] = { a: false, b: false };
        if (d.a !== undefined) sources[k].a = true;
        if (d.b !== undefined) sources[k].b = true;
      }
    }
    return { keys: Array.from(keys).sort(), sources };
  }, [rematchedData]);

  const normalTableWidth = useMemo(() => {
    let w = EXPAND_COL_WIDTH;
    w += getColumnWidth('__title__');
    w += getColumnWidth('__id__');
    for (const key of visibleColumnList) w += getColumnWidth(key);
    return w + SCROLLBAR_WIDTH;
  }, [visibleColumnList, getColumnWidth]);

  const cmpTitleWidth = getColumnWidth('__cmp_title__');
  const cmpIdWidth = getColumnWidth('__cmp_id__');

  const compareLeftContentWidth = useMemo(() => {
    let w = cmpTitleWidth;
    if (!ignoreIdColumn) w += cmpIdWidth;
    for (const k of compareVisibleAttrColumns) w += getColumnWidth(k);
    w += COMPARE_TREE_COL_WIDTH;
    return w;
  }, [cmpTitleWidth, cmpIdWidth, ignoreIdColumn, compareVisibleAttrColumns, getColumnWidth]);

  const compareRightContentWidth = useMemo(() => {
    let w = COMPARE_TREE_COL_WIDTH;
    w += cmpTitleWidth;
    if (!ignoreIdColumn) w += cmpIdWidth;
    for (const k of compareVisibleAttrColumns) w += getColumnWidth(k);
    return w;
  }, [cmpTitleWidth, cmpIdWidth, ignoreIdColumn, compareVisibleAttrColumns, getColumnWidth]);

  // 计算需要填补的空白宽度
  const leftExtraWidth = Math.max(0, leftPanelWidth - compareLeftContentWidth);
  const rightExtraWidth = Math.max(0, rightPanelWidth - compareRightContentWidth);

  const actualCompareLeftWidth = compareLeftContentWidth + leftExtraWidth;
  const actualCompareRightWidth = compareRightContentWidth + rightExtraWidth;

  const compareStats = useMemo(() => {
    if (!compareData) return null;
    let same = 0, modified = 0, aOnly = 0, bOnly = 0;
    for (const r of compareData) {
      if (r.status === 'same') same++;
      else if (r.status === 'modified') modified++;
      else if (r.status === 'a-only') aOnly++;
      else bOnly++;
    }
    return { same, modified, aOnly, bOnly, total: compareData.length };
  }, [compareData]);

  const compareRowsFiltered = useMemo(() => {
    if (!compareData) return [];
    return onlyDiff ? compareData.filter(r => r.status !== 'same') : compareData;
  }, [compareData, onlyDiff]);

  const detectionTooltip = useMemo(() => {
    if (!lastDetection) return '';
    return `Adapter: ${lastDetection.config.name} (confidence: ${lastDetection.confidence}).`;
  }, [lastDetection]);

  // ===== Compare view: unified scroll handling (Vertical + Horizontal Sync) =====
  useEffect(() => {
    if (!isCompareMode) return;
    const timer = window.setTimeout(() => {
      const l = leftScrollerRef.current;
      const r = rightScrollerRef.current;
      if (!l || !r) return;
      let syncing = false;

      const mirrorHeader = (
        src: HTMLElement,
        header: HTMLDivElement | null
      ) => {
        if (header) {
          header.style.transform = `translateX(${-src.scrollLeft}px)`;
        }
      };

      const onL = () => {
        mirrorHeader(l, leftHeaderContentRef.current);
        if (syncing) return;
        syncing = true;
        r.scrollTop = l.scrollTop;
        r.scrollLeft = l.scrollLeft;
        requestAnimationFrame(() => { syncing = false; });
      };
      const onR = () => {
        mirrorHeader(r, rightHeaderContentRef.current);
        if (syncing) return;
        syncing = true;
        l.scrollTop = r.scrollTop;
        l.scrollLeft = r.scrollLeft;
        requestAnimationFrame(() => { syncing = false; });
      };

      l.addEventListener('scroll', onL, { passive: true });
      r.addEventListener('scroll', onR, { passive: true });

      (l as any).__cmpSyncCleanup = () => {
        l.removeEventListener('scroll', onL);
        r.removeEventListener('scroll', onR);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      const l = leftScrollerRef.current as any;
      if (l && typeof l.__cmpSyncCleanup === 'function') {
        l.__cmpSyncCleanup();
        delete l.__cmpSyncCleanup;
      }
    };
  }, [isCompareMode]);

  // ===== Detail panel splitter drag =====
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      const delta = drag.startY - e.clientY;
      let next = drag.startHeight + delta;
      const minHeight = 60;
      const maxHeight = window.innerHeight - 200;
      if (next < minHeight) next = minHeight;
      if (next > maxHeight) next = maxHeight;
      setDetailHeight(next);
    };
    const handleMouseUp = () => {
      if (dragStartRef.current) {
        dragStartRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { startY: e.clientY, startHeight: detailHeight };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const handleSplitterDoubleClick = () => {
    setDetailHeight(DEFAULT_DETAIL_HEIGHT);
  };

  // ===== Column preferences =====
  useEffect(() => {
    (async () => {
      try {
        const has = await exists(PREFS_FILE, { baseDir: BaseDirectory.AppData });
        if (has) {
          const text = await readTextFile(PREFS_FILE, { baseDir: BaseDirectory.AppData });
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            prefsRef.current = parsed as ColumnPrefs;
          }
        }
      } catch (e) {
        console.warn('Failed to read column preferences:', e);
      }
      setPrefsLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!prefsLoaded || attributeColumns.length === 0) return;
    const saved = prefsRef.current[currentFileName];
    if (saved && Array.isArray(saved)) {
      const valid = saved.filter(k => attributeColumns.includes(k));
      setVisibleColumns(new Set(valid));
    } else {
      setVisibleColumns(new Set(attributeColumns));
    }
  }, [attributeColumns, currentFileName, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded || !currentFileName || attributeColumns.length === 0) return;
    const saved = prefsRef.current[currentFileName] || [];
    const currentArr = Array.from(visibleColumns).sort();
    const savedArr = saved.slice().sort();
    const same =
      currentArr.length === savedArr.length &&
      currentArr.every((v, i) => v === savedArr[i]);
    if (same) return;

    const timer = setTimeout(async () => {
      const next: ColumnPrefs = {
        ...prefsRef.current,
        [currentFileName]: Array.from(visibleColumns),
      };
      prefsRef.current = next;
      try {
        await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
        await writeTextFile(PREFS_FILE, JSON.stringify(next, null, 2), {
          baseDir: BaseDirectory.AppData,
        });
      } catch (e) {
        console.warn('Failed to save column preferences:', e);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [visibleColumns, currentFileName, prefsLoaded, attributeColumns]);

  useEffect(() => {
    if (!columnPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (columnPanelRef.current && !columnPanelRef.current.contains(e.target as Node)) {
        setColumnPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [columnPanelOpen]);

  useEffect(() => {
    if (!openFilterColumn) return;
    const handler = (e: MouseEvent) => {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        setOpenFilterColumn(null);
        setFilterPanelPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openFilterColumn]);

  const toggleColumn = (key: string) => {
    setVisibleColumns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectAllColumns = () => setVisibleColumns(new Set(attributeColumns));
  const clearAllColumns = () => setVisibleColumns(new Set());

  // ===== Search =====
  useEffect(() => {
    const q = deferredSearchText;
    if (!q.trim()) {
      setMatchedIds(new Set());
      setAncestorIds(new Set());
      return;
    }
    const lower = q.toLowerCase();
    const matches = new Set<string>();
    const ancestors = new Set<string>();

    const traverse = (nodes: SpecObjectIndex[], path: string[]) => {
      nodes.forEach(node => {
        let isMatch = false;
        if (node.title.toLowerCase().includes(lower)) isMatch = true;
        if (node.id.toLowerCase().includes(lower)) isMatch = true;
        if (!isMatch && node.attributes) {
          for (const v of Object.values(node.attributes)) {
            if (v.toLowerCase().includes(lower)) { isMatch = true; break; }
          }
        }
        if (isMatch) {
          matches.add(node.id);
          path.forEach(pid => ancestors.add(pid));
        }
        traverse(node.children, [...path, node.id]);
      });
    };
    traverse(rootData, []);

    setMatchedIds(matches);
    setAncestorIds(ancestors);

    setExpandedNodes(prev => {
      const next = new Set(prev);
      ancestors.forEach(id => next.add(id));
      return next;
    });
  }, [deferredSearchText, rootData]);

  const filteredRowIds = useMemo(() => {
    if (!deferredSearchText.trim()) return displayRowIds;
    const keep = new Set<string>([...matchedIds, ...ancestorIds]);
    return displayRowIds.filter(id => keep.has(id));
  }, [displayRowIds, deferredSearchText, matchedIds, ancestorIds]);

  // ===== Column filter value options =====
  const activeFilterColumnOptions = useMemo<FilterOption[]>(() => {
    if (!openFilterColumn) return [];
    const counter = new Map<string, number>();
    for (const id of filteredRowIds) {
      const entry = nodeMap.get(id);
      if (!entry) continue;
      const v = entry.node.attributes?.[openFilterColumn] ?? '';
      counter.set(v, (counter.get(v) || 0) + 1);
    }
    const arr = Array.from(counter.entries()).map(([value, count]) => ({ value, count }));
    arr.sort((a, b) => a.value.localeCompare(b.value));
    return arr;
  }, [filteredRowIds, openFilterColumn, nodeMap]);

  // ===== Final visible id list (normal mode) =====
  const finalRowIds = useMemo(() => {
    const filterKeys = Object.keys(columnFilters);
    if (filterKeys.length === 0) return filteredRowIds;
    return filteredRowIds.filter(id => {
      const entry = nodeMap.get(id);
      if (!entry) return false;
      const attrs = entry.node.attributes;
      for (const key of filterKeys) {
        const allowed = columnFilters[key];
        const v = attrs?.[key] ?? '';
        if (!allowed.has(v)) return false;
      }
      return true;
    });
  }, [filteredRowIds, columnFilters, nodeMap]);

  useEffect(() => {
    setColumnFilters(prev => {
      const keep = Object.keys(prev).filter(k => visibleColumnList.includes(k));
      if (keep.length === Object.keys(prev).length) return prev;
      const next: Record<string, Set<string>> = {};
      for (const k of keep) next[k] = prev[k];
      return next;
    });
  }, [visibleColumnList]);

  // ===== Column filter operations =====
  const toggleFilterValue = useCallback(
    (colKey: string, value: string, allValues: string[]) => {
      setColumnFilters(prev => {
        const current = prev[colKey] ?? new Set(allValues);
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        const newFilters = { ...prev };
        if (next.size === allValues.length && allValues.every(v => next.has(v))) {
          delete newFilters[colKey];
        } else {
          newFilters[colKey] = next;
        }
        return newFilters;
      });
    },
    []
  );

  const selectAllFilterValues = useCallback((colKey: string) => {
    setColumnFilters(prev => {
      const next = { ...prev };
      delete next[colKey];
      return next;
    });
  }, []);

  const clearFilterValues = useCallback((colKey: string) => {
    setColumnFilters(prev => ({ ...prev, [colKey]: new Set<string>() }));
  }, []);

  const invertFilterValues = useCallback((colKey: string, allValues: string[]) => {
    setColumnFilters(prev => {
      const current = prev[colKey] ?? new Set(allValues);
      const inverted = new Set<string>();
      for (const v of allValues) if (!current.has(v)) inverted.add(v);
      const next = { ...prev };
      if (inverted.size === allValues.length) {
        delete next[colKey];
      } else {
        next[colKey] = inverted;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (isCompareMode) return;
    if (rootData.length === 0) {
      setStatus('Ready');
      return;
    }
    if (deferredSearchText.trim()) {
      const total = countTotal(rootData);
      setStatus(`Search "${deferredSearchText}": ${matchedIds.size} matches / ${total} total`);
    }
  }, [deferredSearchText, matchedIds, rootData, setStatus, isCompareMode]);

  // ===== Expand / collapse =====
  const handleToggleExpand = useCallback((nodeId: string) => {
    startTransition(() => {
      setExpandedNodes(prev => {
        const newSet = new Set(prev);
        if (newSet.has(nodeId)) newSet.delete(nodeId);
        else newSet.add(nodeId);
        return newSet;
      });
    });
  }, []);

  const handleToggleExpandB = useCallback((nodeId: string) => {
    startTransition(() => {
      setExpandedNodesB(prev => {
        const newSet = new Set(prev);
        if (newSet.has(nodeId)) newSet.delete(nodeId);
        else newSet.add(nodeId);
        return newSet;
      });
    });
  }, []);

  const handleRowClick = useCallback((id: string) => {
    setSelectedRowId(id);
  }, []);

  const parseWithWorker = useCallback(
    (arrayBuffer: ArrayBuffer): Promise<ParsedReqif> => {
      return new Promise((resolve, reject) => {
        const worker = new ParseWorker();
        worker.postMessage(arrayBuffer);
        worker.onmessage = (e) => {
          const { success, indexes, toolId, sourceToolId, error } = e.data;
          worker.terminate();
          if (success) {
            resolve({ indexes, toolId, sourceToolId });
          } else {
            reject(new Error(error || 'Parse failed'));
          }
        };
        worker.onerror = (e) => {
          worker.terminate();
          reject(new Error(e.message || 'Worker internal error'));
        };
      });
    },
    []
  );

  const handleFile = useCallback(
    async (file: File) => {
      setLoading(true);
      setStatus(`Opening ${file.name}...`);

      setSelectedRowId(null);
      setSearchText('');
      setMatchedIds(new Set());
      setAncestorIds(new Set());
      setRootData([]);
      setBRootData([]);
      setExpandedNodesB(new Set());
      setColumnPanelOpen(false);
      setRawCompareData(null);
      setBRename({});
      setIgnoredAttrs(new Set());
      setTitleColumnA('');
      setTitleColumnB('');
      setIgnoreIdColumn(false);
      setCompareFileName('');
      setOnlyDiff(false);
      setColumnFilters({});
      setOpenFilterColumn(null);
      setFilterPanelPos(null);
      setCurrentToolInfo(null);
      setLastDetection(null);

      try {
        setCurrentFileName(file.name);
        const startTime = performance.now();

        const cacheKey = hashString(`${file.name}_${file.size}_${file.lastModified}`);
        const cacheRelPath = `${CACHE_DIR}/${cacheKey}.json`;

        let cacheHit = false;
        try {
          const hasCache = await exists(cacheRelPath, { baseDir: BaseDirectory.AppData });
          if (hasCache) {
            const text = await readTextFile(cacheRelPath, { baseDir: BaseDirectory.AppData });
            const parsed = JSON.parse(text);
            if (parsed && parsed.version === CACHE_VERSION && parsed.index) {
              const rootObjects = deserializeIndexes(parsed.index);
              const elapsed = Math.round(performance.now() - startTime);

              applyData(
                rootObjects,
                `Loaded ${file.name} from cache (index took ${elapsed} ms, backfilling details...)`,
                true,
                'success'
              );

              const info = buildToolInfo(file.name, rootObjects, parsed.index.toolId, parsed.index.sourceToolId);
              setCurrentToolInfo(info);

              cacheHit = true;
              setLoading(false);

              (async () => {
                try {
                  const arrayBuffer = await file.arrayBuffer();
                  const fullParsed = await parseWithWorker(arrayBuffer);
                  const elapsed2 = Math.round(performance.now() - startTime);

                  setRootData(fullParsed.indexes);

                  const info2 = buildToolInfo(file.name, fullParsed.indexes, fullParsed.toolId, fullParsed.sourceToolId);
                  setCurrentToolInfo(info2);

                  setStatus(`Loaded from cache and backfilled details (total ${elapsed2} ms)`, 'success');
                } catch (e: any) {
                  console.warn('Failed to backfill details:', e);
                  setStatus(`Loaded from cache (backfill failed: ${e?.message || String(e)})`, 'error');
                }
              })();
            }
          }
        } catch (e) {
          console.warn('Failed to read cache, will re-parse:', e);
        }

        if (cacheHit) return;

        const arrayBuffer = await file.arrayBuffer();
        const parsed = await parseWithWorker(arrayBuffer);
        const elapsed = Math.round(performance.now() - startTime);

        applyData(parsed.indexes, `Parsed and cached ${file.name} (took ${elapsed} ms)`);

        const info = buildToolInfo(file.name, parsed.indexes, parsed.toolId, parsed.sourceToolId);
        setCurrentToolInfo(info);

        (async () => {
          try {
            try {
              await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
            } catch (mkdirErr) { /* Directory already exists — ignore */ }

            const index = serializeIndexes(parsed);
            const payload = {
              version: CACHE_VERSION,
              timestamp: Date.now(),
              fileName: file.name,
              fileSize: file.size,
              fileLastModified: file.lastModified,
              index,
            };
            await writeTextFile(cacheRelPath, JSON.stringify(payload), {
              baseDir: BaseDirectory.AppData,
            });
          } catch (e) {
            console.warn('Failed to write cache:', e);
          }
        })();
      } catch (err: any) {
        console.error('File read error:', err);
        setStatus(`File read failed: ${err.message}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [setStatus, applyData, parseWithWorker, buildToolInfo]
  );

  const handleCompareFile = useCallback(
    async (file: File) => {
      if (rootData.length === 0) {
        setStatus('Please open a file first', 'error');
        return;
      }
      setLoading(true);
      setStatus(`Parsing comparison file ${file.name}...`);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const parsedB = await parseWithWorker(arrayBuffer);

        const targetInfo = buildToolInfo(file.name, parsedB.indexes, parsedB.toolId, parsedB.sourceToolId);

        let detection: DetectionResult;
        if (currentToolInfo) {
          detection = detectAdapter(currentToolInfo, targetInfo);
        } else {
          detection = {
            config: detectAdapter(
              {
                fileName: currentFileName,
                toolId: undefined,
                sourceToolId: undefined,
                rawAttributeKeys: new Set<string>(),
              },
              targetInfo
            ).config,
            confidence: 'low',
            reason: 'Source file tool info missing; using auto-detection fallback',
          };
        }

        const rows = compareWithAdapter(rootData, parsedB.indexes, detection.config);

        setBRootData(parsedB.indexes);
        {
          const allExpandable = new Set<string>();
          const collect = (nodes: SpecObjectIndex[]) => {
            for (const n of nodes) {
              if (n.children.length > 0) { allExpandable.add(n.id); collect(n.children); }
            }
          };
          collect(parsedB.indexes);
          setExpandedNodesB(allExpandable);
        }

        setBRename({});
        setIgnoredAttrs(new Set());
        setTitleColumnA('');
        setTitleColumnB('');
        setIgnoreIdColumn(false);
        setRawCompareData(rows);
        setCompareFileName(file.name);
        setOnlyDiff(false);
        setSelectedRowId(null);
        setColumnFilters({});
        setOpenFilterColumn(null);
        setFilterPanelPos(null);
        setLastDetection(detection);

        const stats = { same: 0, modified: 0, aOnly: 0, bOnly: 0 };
        for (const r of rows) {
          if (r.status === 'same') stats.same++;
          else if (r.status === 'modified') stats.modified++;
          else if (r.status === 'a-only') stats.aOnly++;
          else stats.bOnly++;
        }

        const baseStats =
          `Same ${stats.same} | Modified ${stats.modified} | A-only ${stats.aOnly} | B-only ${stats.bOnly}`;

        if (detection.config.id === 'generic') {
          setStatus(
            `Comparison complete using default columns. ${baseStats}`,
            'info'
          );
        } else {
          setStatus(
            `Comparison complete (${detection.config.name}): ${baseStats}`,
            'success'
          );
        }
      } catch (e: any) {
        console.error('Comparison failed:', e);
        setStatus(`Comparison failed: ${e?.message || String(e)}`, 'error');
      } finally {
        setLoading(false);
      }
    },
    [rootData, parseWithWorker, setStatus, currentToolInfo, currentFileName, buildToolInfo]
  );

  const handleExitCompare = useCallback(() => {
    setRawCompareData(null);
    setBRename({});
    setIgnoredAttrs(new Set());
    setTitleColumnA('');
    setTitleColumnB('');
    setIgnoreIdColumn(false);
    setCompareFileName('');
    setOnlyDiff(false);
    setBRootData([]);
    setExpandedNodesB(new Set());
    setColumnFilters({});
    setOpenFilterColumn(null);
    setFilterPanelPos(null);
    setLastDetection(null);
    setStatus('Exited compare mode');
  }, [setStatus]);

  const handleClearCache = useCallback(async () => {
    try {
      const entries = await readDir(CACHE_DIR, { baseDir: BaseDirectory.AppData });
      let deleted = 0;
      let kept = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (entry.name === PREFS_FILE_NAME) { kept++; continue; }
        try {
          await remove(`${CACHE_DIR}/${entry.name}`, { baseDir: BaseDirectory.AppData });
          deleted++;
        } catch (e) {
          console.warn('Failed to delete cache file:', entry.name, e);
        }
      }
      setStatus(`Cache cleared: deleted ${deleted} index file(s), kept ${kept} preference file(s)`, 'success');
    } catch (e: any) {
      console.warn('Failed to read cache directory:', e);
      setStatus(`Failed to clear cache (cache directory may not exist): ${e?.message || String(e)}`, 'error');
    }
  }, [setStatus]);

  const handleExportCsv = useCallback(async () => {
    if (isCompareMode && compareData) {
      const rowsToExport = compareRowsFiltered;
      if (rowsToExport.length === 0) {
        setStatus('No data to export in the current view', 'error');
        return;
      }
      const exportColumns = effectiveColumnList;
      const headers = ['Diff', 'ID', 'Title', ...exportColumns];
      const lines: string[] = [headers.map(escapeCsv).join(',')];
      rowsToExport.forEach(r => {
        const cells: string[] = [r.status, r.id, r.title];
        exportColumns.forEach(k => {
          const d = r.attrDiff[k];
          if (!d) { cells.push(''); return; }
          if (d.same) { cells.push(d.a ?? d.b ?? ''); return; }
          const a = d.a ?? '';
          const b = d.b ?? '';
          cells.push(`${a} -> ${b}`);
        });
        lines.push(cells.map(escapeCsv).join(','));
      });
      const csvContent = '\uFEFF' + lines.join('\r\n');
      const aName = currentFileName.replace(/\.(reqifz?|xml)$/i, '') || 'A';
      const bName = compareFileName.replace(/\.(reqifz?|xml)$/i, '') || 'B';
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const defaultFileName = `compare_${aName}_vs_${bName}_${timestamp}.csv`;
      try {
        setStatus(`Preparing to export comparison table with ${rowsToExport.length} rows...`);
        const filePath = await save({
          defaultPath: defaultFileName,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (!filePath) { setStatus('Export cancelled'); return; }
        await writeTextFile(filePath, csvContent);
        setStatus(`Exported comparison table (${rowsToExport.length} rows) to ${filePath}`, 'success');
      } catch (err: any) {
        console.error('Export failed:', err);
        setStatus(`Export failed: ${err?.message || String(err)}`, 'error');
      }
      return;
    }

    if (finalRowIds.length === 0) {
      setStatus('No data to export in the current view', 'error');
      return;
    }
    const headers = ['Depth', 'Title', 'ID', ...visibleColumnList];
    const lines: string[] = [headers.map(escapeCsv).join(',')];
    finalRowIds.forEach(id => {
      const entry = nodeMap.get(id);
      if (!entry) return;
      const { node, depth } = entry;
      const cells: string[] = [
        String(depth), node.title || '', node.id || '',
        ...visibleColumnList.map(k => node.attributes?.[k] ?? ''),
      ];
      lines.push(cells.map(escapeCsv).join(','));
    });
    const csvContent = '\uFEFF' + lines.join('\r\n');
    const baseName = currentFileName.replace(/\.(reqifz?|xml)$/i, '') || 'export';
    const suffix = searchText.trim() ? '_filtered' : '_all';
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const defaultFileName = `${baseName}${suffix}_${timestamp}.csv`;
    try {
      setStatus(`Preparing to export ${finalRowIds.length} rows x ${visibleColumnList.length + 3} columns...`);
      const filePath = await save({
        defaultPath: defaultFileName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!filePath) { setStatus('Export cancelled'); return; }
      await writeTextFile(filePath, csvContent);
      setStatus(`Exported ${finalRowIds.length} rows to ${filePath}`, 'success');
    } catch (err: any) {
      console.error('Export failed:', err);
      setStatus(`Export failed: ${err?.message || String(err)}`, 'error');
    }
  }, [
    isCompareMode, compareData, compareRowsFiltered, visibleColumnList,
    effectiveColumnList, finalRowIds, nodeMap,
    currentFileName, compareFileName, searchText, setStatus,
  ]);

  const statusColor =
    statusType === 'error' ? '#c0392b' : statusType === 'success' ? '#1e7a3e' : '#333';

  const activeFilterCount = Object.keys(columnFilters).length;

  const openFilterPanel = useCallback((e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFilterPanelPos({ top: rect.bottom + 4, left: rect.left });
    setOpenFilterColumn(prev => (prev === key ? null : key));
  }, []);

  const closeFilterPanel = useCallback(() => {
    setOpenFilterColumn(null);
    setFilterPanelPos(null);
  }, []);

  const renderFilterPanel = (colKey: string) => {
    const options = activeFilterColumnOptions;
    const allValues = options.map(o => o.value);
    const selected = columnFilters[colKey];
    const allSelected = selected === undefined;
    const checkValue = (v: string) => allSelected || selected!.has(v);

    return (
      <div
        ref={filterPanelRef}
        className="doors-filter-panel"
        style={{ position: 'fixed', top: filterPanelPos?.top ?? 0, left: filterPanelPos?.left ?? 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="doors-filter-panel-title">Filter: {colKey}</div>
        <div className="doors-filter-actions">
          <button className="doors-btn" onClick={() => selectAllFilterValues(colKey)}>Select all</button>
          <button className="doors-btn" onClick={() => clearFilterValues(colKey)}>Clear</button>
          <button className="doors-btn" onClick={() => invertFilterValues(colKey, allValues)}>Invert</button>
        </div>
        <div className="doors-filter-values">
          {options.length === 0 ? (
            <div style={{ padding: '6px', color: '#888', fontSize: '11px' }}>This column has no values</div>
          ) : (
            options.map(opt => (
              <label key={opt.value} className="doors-filter-value">
                <input
                  type="checkbox"
                  checked={checkValue(opt.value)}
                  onChange={() => toggleFilterValue(colKey, opt.value, allValues)}
                />
                <span className="doors-filter-value-label" title={opt.value}>
                  {opt.value || '(empty)'}
                </span>
                <span className="doors-filter-value-count">({opt.count})</span>
              </label>
            ))
          )}
        </div>
        <div className="doors-filter-footer">
          <button className="doors-btn" onClick={closeFilterPanel}>Close</button>
        </div>
      </div>
    );
  };

  const selectedRowEntry = selectedRowId ? nodeMap.get(selectedRowId) : undefined;
  const selectedRowNode = selectedRowEntry?.node ?? null;

  const selectedCompareRow: CompareRow | null = useMemo(() => {
    if (!isCompareMode || !selectedRowId || !compareData) return null;
    return compareData.find(r => r.id === selectedRowId) ?? null;
  }, [isCompareMode, selectedRowId, compareData]);

  return (
    <div className="doors-app">
      {/* Toolbar */}
      <div className="doors-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept=".reqif,.reqifz,.xml"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
        <button
          className="doors-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Open a .reqif / .reqifz / .xml file"
        >
          Open File...
        </button>

        <input
          type="text"
          className="doors-input"
          placeholder="Search title, ID, or attribute value..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          disabled={isCompareMode}
          style={{ flex: 1, maxWidth: '360px' }}
        />
        {!isCompareMode && searchText && (
          <span style={{ color: '#333', fontSize: '11px' }}>
            {matchedIds.size} matches
            <button
              className="doors-btn"
              onClick={() => setSearchText('')}
              style={{ marginLeft: '6px', padding: '1px 8px' }}
            >
              Clear
            </button>
          </span>
        )}

        {activeFilterCount > 0 && !isCompareMode && (
          <button
            className="doors-btn"
            onClick={() => setColumnFilters({})}
            title="Clear all column filters"
            style={{ background: 'linear-gradient(to bottom, #fff5d5, #f0e2a8)' }}
          >
            Clear filters ({activeFilterCount})
          </button>
        )}

        <div ref={columnPanelRef} style={{ position: 'relative', display: 'inline-block' }}>
          <button
            className="doors-btn"
            onClick={() => setColumnPanelOpen(o => !o)}
            disabled={attributeColumns.length === 0 || isCompareMode}
            title="Select attribute columns to display (preferences auto-saved)"
          >
            Columns ({visibleColumns.size}/{attributeColumns.length})
          </button>
          {columnPanelOpen && !isCompareMode && (
            <div className="doors-popover">
              <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                <button className="doors-btn" onClick={selectAllColumns} style={{ flex: 1, padding: '1px 6px', fontSize: '11px' }}>Select all</button>
                <button className="doors-btn" onClick={clearAllColumns} style={{ flex: 1, padding: '1px 6px', fontSize: '11px' }}>Clear</button>
              </div>
              <div style={{ borderTop: '1px solid #d0d0d0', paddingTop: '6px' }}>
                {attributeColumns.map(key => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={visibleColumns.has(key)}
                      onChange={() => toggleColumn(key)}
                    />
                    {key}
                  </label>
                ))}
              </div>
              <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #d0d0d0', fontSize: '10px', color: '#888' }}>
                Preferences are saved automatically by file name
              </div>
            </div>
          )}
        </div>

        {!isCompareMode ? (
          <>
            <button
              className="doors-btn"
              onClick={() => compareInputRef.current?.click()}
              disabled={rootData.length === 0 || loading}
              title="Select a file to compare with the currently open one"
            >
              Compare with another file...
            </button>
            <input
              ref={compareInputRef}
              type="file"
              accept=".reqif,.reqifz,.xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleCompareFile(f);
                e.target.value = '';
              }}
            />
          </>
        ) : (
          <>
            <span style={{ fontSize: '11px', color: '#333' }}>
              <strong>{currentFileName}</strong>
              <span style={{ margin: '0 6px', color: '#888' }}>vs</span>
              <strong>{compareFileName}</strong>
            </span>
            {lastDetection && (
              <span
                style={{
                  fontSize: '11px',
                  color: '#666',
                  cursor: 'help',
                }}
                title={detectionTooltip}
              >
                [{lastDetection.config.name}]
              </span>
            )}
            <button
              className="doors-btn"
              onClick={() => setMappingPanelOpen(true)}
              title="Manually map or ignore attribute columns before comparing"
              style={{ background: 'linear-gradient(to bottom, #fff5d5, #f0e2a8)' }}
            >
              Configure columns...
            </button>
            <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyDiff}
                onChange={(e) => setOnlyDiff(e.target.checked)}
                style={{ marginRight: '4px' }}
              />
              Only show differences
            </label>
            <button className="doors-btn" onClick={handleExitCompare}>
              Exit compare
            </button>
          </>
        )}

        <button
          className="doors-btn"
          onClick={handleExportCsv}
          disabled={(isCompareMode ? compareRowsFiltered.length === 0 : finalRowIds.length === 0) || loading}
        >
          Export CSV ({isCompareMode ? compareRowsFiltered.length : finalRowIds.length} rows)
        </button>
        <button
          className="doors-btn"
          onClick={handleClearCache}
          title="Clear index cache but keep column preferences"
        >
          Clear cache
        </button>
        {loading && <span style={{ marginLeft: '8px', fontSize: '11px' }}>Loading...</span>}
      </div>

      {/* Table area */}
      <div className="doors-table" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {isCompareMode ? (
          <div
            style={{
              display: 'flex',
              flex: 1,
              minHeight: 0,
              width: '100%',
              background: '#fff',
            }}
          >
            {/* === LEFT PANEL (File A) === */}
            <div
              ref={leftPanelRef}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                background: '#fff',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  flexShrink: 0,
                  display: 'flex',
                  borderBottom: '1px solid #b8b4a8',
                  background: '#e8e4d8',
                  height: 22,
                }}
              >
                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                  <div
                    ref={leftHeaderContentRef}
                    style={{
                      display: 'flex',
                      width: actualCompareLeftWidth - COMPARE_TREE_COL_WIDTH,
                      height: '100%',
                      willChange: 'transform',
                    }}
                  >
                    <div
                      className="doors-th"
                      style={{
                        width: cmpTitleWidth,
                        flexShrink: 0,
                        position: 'relative',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={currentFileName}
                    >
                      <span className="doors-th-label">A: {currentFileName || 'File A'}</span>
                      <div
                        className="col-resize-handle"
                        onMouseDown={(e) => startColumnResize(e, '__cmp_title__')}
                        onDoubleClick={() => resetColumnWidth('__cmp_title__')}
                        title="Drag to resize (double-click to reset)"
                      />
                    </div>
                    {!ignoreIdColumn && (
                      <div
                        className="doors-th"
                        style={{ 
                          width: compareVisibleAttrColumns.length === 0 ? cmpIdWidth + leftExtraWidth : cmpIdWidth, 
                          flexShrink: 0, 
                          position: 'relative' 
                        }}
                      >
                        <span className="doors-th-label">ID</span>
                        <div
                          className="col-resize-handle"
                          onMouseDown={(e) => startColumnResize(e, '__cmp_id__')}
                          onDoubleClick={() => resetColumnWidth('__cmp_id__')}
                          title="Drag to resize (double-click to reset)"
                        />
                      </div>
                    )}
                    {compareVisibleAttrColumns.map((k, idx) => {
                      const w = getColumnWidth(k);
                      const isLast = idx === compareVisibleAttrColumns.length - 1;
                      const finalW = isLast ? w + leftExtraWidth : w;
                      return (
                        <div
                          key={'ha_' + k}
                          className="doors-th"
                          style={{ width: finalW, flexShrink: 0, position: 'relative' }}
                        >
                          <span className="doors-th-label">{k}</span>
                          <div
                            className="col-resize-handle"
                            onMouseDown={(e) => startColumnResize(e, k)}
                            onDoubleClick={() => resetColumnWidth(k)}
                            title="Drag to resize (double-click to reset)"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* 固定在右侧的树列表头 */}
                <div
                  style={{
                    width: COMPARE_TREE_COL_WIDTH,
                    flexShrink: 0,
                    borderLeft: '1px solid #b8b4a8',
                    background: '#e8e4d8',
                    zIndex: 10,
                  }}
                />
              </div>

              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff' }}>
                {compareDisplayIds.length > 0 ? (
                  <Virtuoso
                    scrollerRef={(el) => { 
                      if (el) {
                        leftScrollerRef.current = el as HTMLElement; 
                      }
                    }}
                    data={compareDisplayIds}
                    computeItemKey={(_index, id) => id}
                    fixedItemHeight={ROW_HEIGHT}
                    itemContent={(_index, id) => {
                      const entryA = nodeMap.get(id);
                      const row = compareRowById.get(id);
                      const status = statusByIdMap.get(id) ?? 'same';
                      const isSelected = selectedRowId === id;
                      const aNode = entryA?.node;
                      const expandedA = !!aNode && expandedNodes.has(aNode.id);
                      return (
                        <CompareLeftRow
                          id={id}
                          entryA={entryA}
                          row={row}
                          status={status}
                          isSelected={isSelected}
                          expandedA={expandedA}
                          titleColumnA={titleColumnA}
                          hideIdColumn={ignoreIdColumn}
                          attrColumns={compareVisibleAttrColumns}
                          cmpTitleWidth={cmpTitleWidth}
                          cmpIdWidth={cmpIdWidth}
                          columnWidths={columnWidths}
                          totalWidth={actualCompareLeftWidth}
                          extraWidth={leftExtraWidth}
                          onRowClick={handleRowClick}
                          onToggleA={handleToggleExpand}
                        />
                      );
                    }}
                    style={{ height: '100%' }}
                  />
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                    {onlyDiff ? 'No differences to display' : 'Comparison result is empty'}
                  </div>
                )}
              </div>
            </div>

            {/* === CENTER DIVIDER === */}
            <div
              style={{
                width: COMPARE_DIVIDER_WIDTH,
                flexShrink: 0,
                background: '#808080',
              }}
            />

            {/* === RIGHT PANEL (File B) === */}
            <div
              ref={rightPanelRef}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                background: '#fff',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  flexShrink: 0,
                  display: 'flex',
                  borderBottom: '1px solid #b8b4a8',
                  background: '#e8e4d8',
                  height: 22,
                }}
              >
                {/* 固定在左侧的树列表头 */}
                <div
                  style={{
                    width: COMPARE_TREE_COL_WIDTH,
                    flexShrink: 0,
                    borderRight: '1px solid #b8b4a8',
                    background: '#e8e4d8',
                    zIndex: 10,
                  }}
                />
                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                  <div
                    ref={rightHeaderContentRef}
                    style={{
                      display: 'flex',
                      width: actualCompareRightWidth - COMPARE_TREE_COL_WIDTH,
                      height: '100%',
                      willChange: 'transform',
                    }}
                  >
                    <div
                      className="doors-th"
                      style={{
                        width: cmpTitleWidth,
                        flexShrink: 0,
                        position: 'relative',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={compareFileName}
                    >
                      <span className="doors-th-label">B: {compareFileName || 'File B'}</span>
                      <div
                        className="col-resize-handle"
                        onMouseDown={(e) => startColumnResize(e, '__cmp_title__')}
                        onDoubleClick={() => resetColumnWidth('__cmp_title__')}
                        title="Drag to resize (double-click to reset)"
                      />
                    </div>
                    {!ignoreIdColumn && (
                      <div
                        className="doors-th"
                        style={{ 
                          width: compareVisibleAttrColumns.length === 0 ? cmpIdWidth + rightExtraWidth : cmpIdWidth, 
                          flexShrink: 0, 
                          position: 'relative' 
                        }}
                      >
                        <span className="doors-th-label">ID</span>
                        <div
                          className="col-resize-handle"
                          onMouseDown={(e) => startColumnResize(e, '__cmp_id__')}
                          onDoubleClick={() => resetColumnWidth('__cmp_id__')}
                          title="Drag to resize (double-click to reset)"
                        />
                      </div>
                    )}
                    {compareVisibleAttrColumns.map((k, idx) => {
                      const w = getColumnWidth(k);
                      const isLast = idx === compareVisibleAttrColumns.length - 1;
                      const finalW = isLast ? w + rightExtraWidth : w;
                      return (
                        <div
                          key={'hb_' + k}
                          className="doors-th"
                          style={{ width: finalW, flexShrink: 0, position: 'relative' }}
                        >
                          <span className="doors-th-label">{k}</span>
                          <div
                            className="col-resize-handle"
                            onMouseDown={(e) => startColumnResize(e, k)}
                            onDoubleClick={() => resetColumnWidth(k)}
                            title="Drag to resize (double-click to reset)"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff' }}>
                {compareDisplayIds.length > 0 ? (
                  <Virtuoso
                    scrollerRef={(el) => { 
                      if (el) {
                        rightScrollerRef.current = el as HTMLElement; 
                      }
                    }}
                    data={compareDisplayIds}
                    computeItemKey={(_index, id) => id}
                    fixedItemHeight={ROW_HEIGHT}
                    itemContent={(_index, id) => {
                      const bId = bIdForMerged.get(id) ?? id;
                      const entryB = bNodeMap.get(bId);
                      const row = compareRowById.get(id);
                      const status = statusByIdMap.get(id) ?? 'same';
                      const isSelected = selectedRowId === id;
                      const bNode = entryB?.node;
                      const expandedB = !!bNode && expandedNodesB.has(bNode.id);
                      return (
                        <CompareRightRow
                          id={id}
                          entryB={entryB}
                          row={row}
                          status={status}
                          isSelected={isSelected}
                          expandedB={expandedB}
                          titleColumnB={titleColumnB}
                          hideIdColumn={ignoreIdColumn}
                          attrColumns={compareVisibleAttrColumns}
                          cmpTitleWidth={cmpTitleWidth}
                          cmpIdWidth={cmpIdWidth}
                          columnWidths={columnWidths}
                          totalWidth={actualCompareRightWidth}
                          extraWidth={rightExtraWidth}
                          onRowClick={handleRowClick}
                          onToggleB={handleToggleExpandB}
                        />
                      );
                    }}
                    style={{ height: '100%' }}
                  />
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                    {onlyDiff ? 'No differences to display' : 'Comparison result is empty'}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="doors-table-inner" style={{ minWidth: normalTableWidth }}>
            <div className="doors-table-header">
              <div className="doors-th" style={{ width: EXPAND_COL_WIDTH, flexShrink: 0 }} />
              <div
                className="doors-th doors-th-filter"
                style={{ width: getColumnWidth('__title__'), flexShrink: 0, position: 'relative' }}
              >
                <span className="doors-th-label">Title</span>
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => startColumnResize(e, '__title__')}
                  onDoubleClick={() => resetColumnWidth('__title__')}
                  title="Drag to resize (double-click to reset)"
                />
              </div>
              <div
                className="doors-th doors-th-filter"
                style={{ width: getColumnWidth('__id__'), flexShrink: 0, position: 'relative' }}
              >
                <span className="doors-th-label">ID</span>
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => startColumnResize(e, '__id__')}
                  onDoubleClick={() => resetColumnWidth('__id__')}
                  title="Drag to resize (double-click to reset)"
                />
              </div>
              {visibleColumnList.map(key => {
                const isFiltered = !!columnFilters[key];
                const w = getColumnWidth(key);
                return (
                  <div
                    key={key}
                    className={'doors-th doors-th-filter' + (isFiltered ? ' filtered' : '')}
                    style={{ width: w, flexShrink: 0, position: 'relative' }}
                  >
                    <span className="doors-th-label">{key}</span>
                    <span
                      className={'doors-filter-btn' + (isFiltered ? ' active' : '')}
                      onClick={(e) => openFilterPanel(e, key)}
                      title={isFiltered ? `Filtered ${columnFilters[key].size} value(s)` : 'Click to filter this column'}
                    >
                      {isFiltered ? '▼' : '▽'}
                    </span>
                    <div
                      className="col-resize-handle"
                      onMouseDown={(e) => startColumnResize(e, key)}
                      onDoubleClick={() => resetColumnWidth(key)}
                      title="Drag to resize (double-click to reset)"
                    />
                  </div>
                );
              })}
            </div>
            <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
              {finalRowIds.length > 0 ? (
                <Virtuoso
                  data={finalRowIds}
                  computeItemKey={(_index, id) => id}
                  fixedItemHeight={ROW_HEIGHT}
                  itemContent={(_index, id) => {
                    const entry = nodeMap.get(id);
                    if (!entry) return null;
                    const { node, depth } = entry;
                    const hasChildren = node.children.length > 0;
                    const isExpanded = hasChildren && expandedNodes.has(node.id);
                    return (
                      <TreeRow
                        node={node}
                        depth={depth}
                        hasChildren={hasChildren}
                        isExpanded={isExpanded}
                        isSelected={selectedRowId === node.id}
                        isMatched={matchedIds.has(node.id)}
                        searchText={deferredSearchText}
                        visibleColumnList={visibleColumnList}
                        columnWidths={columnWidths}
                        onRowClick={handleRowClick}
                        onToggleExpand={handleToggleExpand}
                      />
                    );
                  }}
                  style={{ height: '100%' }}
                />
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                  {searchText ? 'No matches' : 'Please select or drop a .reqif or .reqifz file'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Floating filter panel (only in normal mode) */}
      {!isCompareMode && openFilterColumn && filterPanelPos && renderFilterPanel(openFilterColumn)}

      {/* Column mapping panel (only in compare mode) */}
      {isCompareMode && mappingPanelOpen && (
        <ColumnMappingPanel
          keys={rawAttributeKeys.keys}
          sources={rawAttributeKeys.sources}
          initialBRename={bRename}
          initialIgnored={ignoredAttrs}
          initialTitleColumnA={titleColumnA}
          initialTitleColumnB={titleColumnB}
          initialIgnoreId={ignoreIdColumn}
          onApply={(newBRename, newIgnored, newTitleA, newTitleB, newIgnoreId) => {
            setBRename(newBRename);
            setIgnoredAttrs(newIgnored);
            setTitleColumnA(newTitleA);
            setTitleColumnB(newTitleB);
            setIgnoreIdColumn(newIgnoreId);
          }}
          onClose={() => setMappingPanelOpen(false)}
        />
      )}

      {/* Splitter + detail panel */}
      <div
        className="doors-splitter"
        onMouseDown={handleSplitterMouseDown}
        onDoubleClick={handleSplitterDoubleClick}
        title="Drag to resize detail panel (double-click to reset)"
      />
      <div className="doors-detail" style={{ height: detailHeight, overflow: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>{isCompareMode ? 'Comparison Details' : 'Details'}</h3>
        {isCompareMode ? (
          !selectedCompareRow ? (
            <div style={{ color: '#888', fontSize: '12px' }}>
              Click a row in the table above to view the comparison details
            </div>
          ) : (
            <>
              <section style={{ marginBottom: '15px' }}>
                <h4>Basic Info</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%', maxWidth: '800px' }}>
                  <tbody>
                    <tr>
                      <td style={labelCellStyle}>Status</td>
                      <td style={valueCellStyle}>{renderStatusBadge(selectedCompareRow.status)}</td>
                    </tr>
                    <tr>
                      <td style={labelCellStyle}>ID</td>
                      <td style={valueCellStyle}>{selectedCompareRow.id}</td>
                    </tr>
                    <tr>
                      <td style={labelCellStyle}>Title</td>
                      <td style={valueCellStyle}>{selectedCompareRow.title}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              {Object.keys(selectedCompareRow.attrDiff).length > 0 && (
                <section style={{ marginBottom: '15px' }}>
                  <h4>Attribute Differences</h4>
                  <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ background: '#f0efe4', borderBottom: '1px solid #b8b4a8' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px', width: '200px', color: '#333' }}>Attribute</th>
                        <th style={{ textAlign: 'left', padding: '4px 8px', color: '#8b1a1a', borderLeft: '1px solid #d0d0d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={currentFileName}>
                          File A: {currentFileName || 'A'}
                        </th>
                        <th style={{ textAlign: 'left', padding: '4px 8px', color: '#145a2b', borderLeft: '1px solid #d0d0d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={compareFileName}>
                          File B: {compareFileName || 'B'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(selectedCompareRow.attrDiff).map(([key, d]) => (
                        <tr key={key} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ ...labelCellStyle, width: '200px', padding: '4px 8px', whiteSpace: 'normal', wordBreak: 'break-all' }}>{key}</td>
                          <td style={{ 
                            ...valueCellStyle, 
                            padding: '4px 8px',
                            background: !d.same && d.a !== undefined ? '#ffe2e2' : undefined,
                            borderLeft: '1px solid #eee',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            color: d.same ? '#888' : '#000'
                          }}>
                            {d.a !== undefined ? d.a : ''}
                          </td>
                          <td style={{ 
                            ...valueCellStyle, 
                            padding: '4px 8px',
                            borderLeft: '1px solid #eee',
                            background: !d.same && d.b !== undefined ? '#dcf5e3' : undefined,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            color: d.same ? '#888' : '#000'
                          }}>
                            {d.b !== undefined ? d.b : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </>
          )
        ) : (
          !selectedRowNode ? (
            <div style={{ color: '#888', fontSize: '12px' }}>Click a row in the table to view details</div>
          ) : (
            <>
              <section style={{ marginBottom: '10px' }}>
                <h4>Basic Info</h4>
                <table style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
                  <tbody>
                    <tr>
                      <td style={labelCellStyle}>ID</td>
                      <td style={valueCellStyle}>{selectedRowNode.id}</td>
                    </tr>
                    <tr>
                      <td style={labelCellStyle}>Title</td>
                      <td style={valueCellStyle}>{selectedRowNode.title}</td>
                    </tr>
                    {selectedRowNode.typeName && (
                      <tr>
                        <td style={labelCellStyle}>Type</td>
                        <td style={valueCellStyle}>
                          {selectedRowNode.typeName}
                          {selectedRowNode.typeRef && (
                            <span style={{ color: '#888', marginLeft: '6px' }}>({selectedRowNode.typeRef})</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>

              {selectedRowNode.attributes && Object.keys(selectedRowNode.attributes).length > 0 && (
                <section style={{ marginBottom: '10px' }}>
                  <h4>Attributes</h4>
                  <table style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
                    <tbody>
                      {Object.entries(selectedRowNode.attributes).map(([k, v]) => (
                        <tr key={k}>
                          <td style={labelCellStyle}>{k}</td>
                          <td style={{ ...valueCellStyle, whiteSpace: 'pre-wrap' }}>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              {selectedRowNode.images && selectedRowNode.images.length > 0 && (
                <section style={{ marginBottom: '10px' }}>
                  <h4>Embedded images ({selectedRowNode.images.length})</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    {selectedRowNode.images.map((img, idx) => (
                      <div key={idx} style={{ textAlign: 'center' }}>
                        <img
                          src={img.dataUrl}
                          alt={img.path}
                          style={{
                            maxWidth: '200px', maxHeight: '200px',
                            minWidth: '32px', minHeight: '32px',
                            border: '1px solid #808080', background: '#fafafa',
                            display: 'block', imageRendering: 'pixelated',
                          }}
                        />
                        <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>{img.path}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {selectedRowNode.xml ? (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: '12px', color: '#333', userSelect: 'none' }}>
                    Raw XML
                  </summary>
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap', fontSize: '11px',
                      background: '#f7f7f7', padding: '6px', marginTop: '6px',
                      border: '1px solid #d0d0d0', maxHeight: '200px', overflow: 'auto',
                    }}
                  >
                    {selectedRowNode.xml}
                  </pre>
                </details>
              ) : (
                <div style={{ fontSize: '11px', color: '#888', marginTop: '6px' }}>
                  Details loading... (XML will be backfilled in the background on first open)
                </div>
              )}
            </>
          )
        )}
      </div>

      {/* Bottom status bar */}
      <div className="doors-statusbar" style={{ color: statusColor }} title={statusMessage}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {statusMessage}
        </span>
        {isCompareMode && compareStats ? (
          <span style={{ color: '#555', flexShrink: 0 }}>
            Same {compareStats.same} | Modified {compareStats.modified} | A-only {compareStats.aOnly} | B-only {compareStats.bOnly}
            {ignoreIdColumn && ' | matched by title'}
          </span>
        ) : (
          rootData.length > 0 && attributeColumns.length > 0 && (
            <span style={{ color: '#555', flexShrink: 0 }}>
              Showing {visibleColumns.size} / {attributeColumns.length} columns
              {activeFilterCount > 0 && ` | Filtered ${activeFilterCount} column(s)`}
            </span>
          )
        )}
      </div>

      {/* Loading overlay */}
      {loading && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(240,240,240,0.7)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{
            border: '4px solid #d8d4c8', borderTop: '4px solid #0a246a',
            borderRadius: '50%', width: '36px', height: '36px',
            animation: 'spin 1s linear infinite',
          }} />
        </div>
      )}
    </div>
  );
}