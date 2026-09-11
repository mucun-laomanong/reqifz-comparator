import { AdapterConfig, DetectionResult, ToolDetectionInfo } from './types';
import generic from './presets/generic';
import doorsToPolarion from './presets/doors-to-polarion';
import doorsToDoorsNext from './presets/doors-to-doors-next';

// Built-in configs
const builtinConfigs: AdapterConfig[] = [
  generic,
  doorsToPolarion,
  doorsToDoorsNext,
];

/**
 * Fingerprint library for common enterprise REQIF tools.
 * When these tools are detected, even if there are no specific cross-tool mapping rules,
 * we can assign a high confidence and use the Generic config (as the format is usually standard enough).
 */
const KNOWN_TOOLS = [
  { id: 'doors', name: 'IBM DOORS', pattern: /DOORS(?!\s*Next)/i, attrPattern: /ReqIf\.Text|DOORS\./i },
  { id: 'doors-next', name: 'IBM DOORS Next', pattern: /DOORS\s*Next|DNG|Rational DOORS Next/i, attrPattern: /RM\./i },
  { id: 'polarion', name: 'Siemens Polarion', pattern: /Polarion/i, attrPattern: /polarion-|polarion\./i },
  { id: 'codebeamer', name: 'PTC Codebeamer', pattern: /Codebeamer/i, attrPattern: /cb_|codebeamer\./i },
  { id: 'jama', name: 'Jama Connect', pattern: /Jama/i, attrPattern: /jama/i },
  { id: 'visure', name: 'Visure Requirements', pattern: /Visure/i, attrPattern: /visure/i },
  { id: 'reqif-studio', name: 'ReqIF Studio', pattern: /ReqIF\s*Studio/i, attrPattern: /ReqIf\./i },
  { id: 'sparx', name: 'Sparx Enterprise Architect', pattern: /Enterprise Architect|Sparx/i, attrPattern: /EA_/i },
  { id: 'doors-requirements', name: 'DOORS Requirements', pattern: /Requirements/i, attrPattern: /ReqIf\./i }
];

// Resolve `extends`: merge parent fields into the child config.
function resolveInheritance(
  config: AdapterConfig,
  byId: Map<string, AdapterConfig>
): AdapterConfig {
  if (!config.extends) return config;
  const parent = byId.get(config.extends);
  if (!parent) return config;
  const resolvedParent = resolveInheritance(parent, byId);

  return {
    ...resolvedParent,
    ...config,
    ignore: {
      ...resolvedParent.ignore,
      ...config.ignore,
    },
    attributeMapping: {
      map: {
        ...resolvedParent.attributeMapping.map,
        ...config.attributeMapping.map,
      },
      preferredSource:
        config.attributeMapping.preferredSource ??
        resolvedParent.attributeMapping.preferredSource,
    },
    valueCompare: {
      ...resolvedParent.valueCompare,
      ...config.valueCompare,
    },
  };
}

// Look up a config by id (with inheritance resolved).
export function getAdapter(id: string, custom: AdapterConfig[] = []): AdapterConfig {
  const all = [...builtinConfigs, ...custom];
  const byId = new Map(all.map(c => [c.id, c]));
  const target = byId.get(id);
  if (!target) return generic;
  return resolveInheritance(target, byId);
}

// List all available configs.
export function listAdapters(
  custom: AdapterConfig[] = []
): { id: string; name: string }[] {
  return [...builtinConfigs, ...custom].map(c => ({ id: c.id, name: c.name }));
}

// ---- Multi-level detection ----

function pickToolLabel(info: ToolDetectionInfo): string {
  return info.toolId || info.sourceToolId || '(unknown)';
}

/**
 * Helper function: try to identify if it's a known tool.
 * First match by Tool ID, then fallback to matching attribute fingerprints.
 */
function identifyKnownTool(info: ToolDetectionInfo): { id: string; name: string } | null {
  const labels = [info.toolId, info.sourceToolId].filter(Boolean) as string[];
  
  // 1. Try to identify by Tool ID
  for (const label of labels) {
    for (const tool of KNOWN_TOOLS) {
      if (tool.pattern.test(label)) {
        return { id: tool.id, name: tool.name };
      }
    }
  }

  // 2. Try to identify by attribute fingerprint (Fallback)
  const keys = Array.from(info.rawAttributeKeys);
  if (keys.length > 0) {
    for (const tool of KNOWN_TOOLS) {
      if (tool.attrPattern && keys.some(k => tool.attrPattern.test(k))) {
        return { id: tool.id, name: tool.name };
      }
    }
  }

  return null;
}

// Level 1: tool-id match (highest confidence) - for specific cross-tool mapping rules.
function tryMatchByToolId(
  source: ToolDetectionInfo,
  target: ToolDetectionInfo,
  configs: AdapterConfig[],
  custom: AdapterConfig[]
): DetectionResult | null {
  const sourceLabels = [source.toolId, source.sourceToolId].filter(Boolean) as string[];
  const targetLabels = [target.toolId, target.sourceToolId].filter(Boolean) as string[];
  if (sourceLabels.length === 0 || targetLabels.length === 0) return null;

  for (const cfg of configs) {
    if (!cfg.detection) continue;
    const { sourceToolIdPattern, targetToolIdPattern } = cfg.detection;
    if (!sourceToolIdPattern || !targetToolIdPattern) continue;

    const sRe = new RegExp(sourceToolIdPattern, 'i');
    const tRe = new RegExp(targetToolIdPattern, 'i');
    const sHit = sourceLabels.find(v => sRe.test(v));
    const tHit = targetLabels.find(v => tRe.test(v));

    if (sHit && tHit) {
      return {
        config: getAdapter(cfg.id, custom),
        confidence: 'high',
        reason: `Tool ID matched: ${sHit} ↔ ${tHit}`,
      };
    }
  }
  return null;
}

// Level 2: file-name match (medium confidence).
function tryMatchByFileName(
  source: ToolDetectionInfo,
  target: ToolDetectionInfo,
  configs: AdapterConfig[],
  custom: AdapterConfig[]
): DetectionResult | null {
  const sName = source.fileName.toLowerCase();
  const tName = target.fileName.toLowerCase();

  for (const cfg of configs) {
    if (!cfg.detection) continue;
    const { sourceToolPattern, targetToolPattern } = cfg.detection;
    if (!sourceToolPattern || !targetToolPattern) continue;

    const sRe = new RegExp(sourceToolPattern, 'i');
    const tRe = new RegExp(targetToolPattern, 'i');
    if (sRe.test(sName) && tRe.test(tName)) {
      return {
        config: getAdapter(cfg.id, custom),
        confidence: 'medium',
        reason: `File name matched: ${source.fileName} ↔ ${target.fileName}`,
      };
    }
  }
  return null;
}

// Level 3: attribute fingerprint (low confidence) - for specific cross-tool mapping rules.
function tryMatchByFingerprint(
  source: ToolDetectionInfo,
  target: ToolDetectionInfo,
  configs: AdapterConfig[],
  custom: AdapterConfig[]
): DetectionResult | null {
  const sKeys = Array.from(source.rawAttributeKeys);
  const tKeys = Array.from(target.rawAttributeKeys);
  if (sKeys.length === 0 || tKeys.length === 0) return null;

  for (const cfg of configs) {
    if (!cfg.detection) continue;
    const { sourceAttributePattern, targetAttributePattern } = cfg.detection;
    if (!sourceAttributePattern || !targetAttributePattern) continue;

    const sRe = new RegExp(sourceAttributePattern);
    const tRe = new RegExp(targetAttributePattern);
    const sHit = sKeys.find(k => sRe.test(k));
    const tHit = tKeys.find(k => tRe.test(k));
    if (sHit && tHit) {
      return {
        config: getAdapter(cfg.id, custom),
        confidence: 'low',
        reason: `Attribute fingerprint matched (based on: ${sHit} / ${tHit})`,
      };
    }
  }
  return null;
}

// Detect the best adapter for a pair of files.
export function detectAdapter(
  source: ToolDetectionInfo,
  target: ToolDetectionInfo,
  custom: AdapterConfig[] = []
): DetectionResult {
  const all = [...builtinConfigs, ...custom];

  // 1. Try to match built-in or custom "specific cross-tool mapping rules" (e.g., DOORS -> Polarion)
  const byToolId = tryMatchByToolId(source, target, all, custom);
  if (byToolId) return byToolId;

  const byFileName = tryMatchByFileName(source, target, all, custom);
  if (byFileName) return byFileName;

  const byFingerprint = tryMatchByFingerprint(source, target, all, custom);
  if (byFingerprint) return byFingerprint;

  // 2. If no specific mapping rule, try to identify which known tool family they belong to
  const sourceTool = identifyKnownTool(source);
  const targetTool = identifyKnownTool(target);

  // 2a. If both sides are the same tool (e.g., both Polarion), use Generic, high confidence
  if (sourceTool && targetTool && sourceTool.id === targetTool.id) {
    return {
      config: generic,
      confidence: 'high',
      reason: `Both files are from ${sourceTool.name}. Using default column mapping.`,
    };
  }

  // 2b. If different tools are identified (e.g., Codebeamer vs Jama), but no cross-tool rule exists
  // Still use Generic, but provide a clear explanation.
  if (sourceTool || targetTool) {
    const sName = sourceTool ? sourceTool.name : pickToolLabel(source);
    const tName = targetTool ? targetTool.name : pickToolLabel(target);
    return {
      config: generic,
      confidence: 'high',
      reason: `Cross-tool comparison recognized: ${sName} ↔ ${tName}. Using generic column mapping (you can configure manual mapping if needed).`,
    };
  }

  // 3. If neither is identified, but Tool IDs exactly match
  if (
    source.toolId &&
    target.toolId &&
    source.toolId.toLowerCase() === target.toolId.toLowerCase()
  ) {
    return {
      config: generic,
      confidence: 'high',
      reason: `Both files were generated by the same tool (${source.toolId}); using generic configuration.`,
    };
  }

  // 4. Ultimate fail-safe logic
  const sourceLabel = pickToolLabel(source);
  const targetLabel = pickToolLabel(target);
  return {
    config: generic,
    confidence: 'low',
    reason:
      sourceLabel !== '(unknown)' || targetLabel !== '(unknown)'
        ? `No known mapping for tool combination (${sourceLabel} ↔ ${targetLabel}), using generic configuration.`
        : 'Could not identify tool types, using generic configuration.',
  };
}