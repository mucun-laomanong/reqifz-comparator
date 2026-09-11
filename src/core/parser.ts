import { unzipSync, Unzipped } from 'fflate';
import * as sax from 'sax';
import { SpecObjectIndex, ParsedReqif } from './index';

function attributesToString(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('');
}

function assignPath(node: SpecObjectIndex, parentPath: string[] = []) {
  const path = [...parentPath, node.id];
  node.hierarchyPath = path;
  node.children.forEach(child => assignPath(child, path));
}

function u8ToDataUrl(data: Uint8Array, path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function resolveImage(
  ref: string,
  unzipped: Unzipped,
  reqifDir: string
): { path: string; dataUrl: string } | null {
  const cleaned = ref.replace(/^\.\//, '');
  const candidates: string[] = [cleaned];
  if (reqifDir) candidates.push(reqifDir + cleaned);
  if (cleaned.startsWith('/')) candidates.push(cleaned.slice(1));

  for (const c of candidates) {
    if (unzipped[c]) return { path: c, dataUrl: u8ToDataUrl(unzipped[c], c) };
  }
  const baseName = cleaned.split('/').pop() || cleaned;
  const key = Object.keys(unzipped).find(k => k === baseName || k.endsWith('/' + baseName));
  if (key) return { path: key, dataUrl: u8ToDataUrl(unzipped[key], key) };
  return null;
}

function looksLikeTitleKey(key: string): boolean {
  return /标题|Title|Name|TXT|Text|Desc|描述/i.test(key);
}

function pickTitleFromAttributes(attrs?: Record<string, string>): string {
  if (!attrs) return '';
  const entries = Object.entries(attrs);
  if (entries.length === 0) return '';
  for (const [k, v] of entries) {
    if (v && looksLikeTitleKey(k)) return v.substring(0, 200);
  }
  for (const [, v] of entries) {
    if (v) return v.substring(0, 200);
  }
  return '';
}

/**
 * All ReqIF attribute value tag names we want to handle.
 * STRING/BOOLEAN/DATE/INTEGER/REAL: value in the `THE-VALUE` attribute.
 * ENUMERATION: value is a reference to an enum value (inside `<ENUM-VALUE-REF>`).
 * XHTML: value is XML content inside the `<THE-VALUE>` child element.
 */
const ATTRIBUTE_VALUE_TAGS = new Set([
  'ATTRIBUTE-VALUE-STRING',
  'ATTRIBUTE-VALUE-BOOLEAN',
  'ATTRIBUTE-VALUE-DATE',
  'ATTRIBUTE-VALUE-INTEGER',
  'ATTRIBUTE-VALUE-REAL',
  'ATTRIBUTE-VALUE-ENUMERATION',
  'ATTRIBUTE-VALUE-XHTML',
]);

/**
 * All ReqIF attribute definition reference tag names.
 * These appear inside `<DEFINITION>` under an `ATTRIBUTE-VALUE-*` element.
 */
const ATTRIBUTE_DEF_REF_TAGS = new Set([
  'ATTRIBUTE-DEFINITION-STRING-REF',
  'ATTRIBUTE-DEFINITION-BOOLEAN-REF',
  'ATTRIBUTE-DEFINITION-DATE-REF',
  'ATTRIBUTE-DEFINITION-INTEGER-REF',
  'ATTRIBUTE-DEFINITION-REAL-REF',
  'ATTRIBUTE-DEFINITION-ENUMERATION-REF',
  'ATTRIBUTE-DEFINITION-XHTML-REF',
]);

/** Strip XML/HTML tags from a string to produce plain text. */
function stripTags(xml: string): string {
  return xml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function parseReqifz(arrayBuffer: ArrayBuffer): ParsedReqif {
  const bytes = new Uint8Array(arrayBuffer);
  const isZip = bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

  let xmlText: string;
  let unzipped: Unzipped | null = null;
  let reqifFileName: string | null = null;

  if (isZip) {
    unzipped = unzipSync(bytes);
    reqifFileName = Object.keys(unzipped).find(name => name.endsWith('.reqif')) || null;
    if (!reqifFileName) throw new Error('No .reqif file found in archive');
    xmlText = new TextDecoder('utf-8').decode(unzipped[reqifFileName]);
  } else {
    xmlText = new TextDecoder('utf-8').decode(bytes);
  }

  if (xmlText.charCodeAt(0) === 0xFEFF) xmlText = xmlText.slice(1);
  xmlText = xmlText.trim();

  console.log('[diag] isZip =', isZip);
  console.log('[diag] xmlText.length =', xmlText.length);
  console.log('[diag] first 300 chars =', JSON.stringify(xmlText.substring(0, 300)));
  console.log('[diag] first 4 bytes (hex) =', Array.from(bytes.subarray(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' '));

  // Non-strict mode tolerates text outside the root node and minor XML issues.
  const parser = sax.parser(false);
  parser.onerror = (e: any) => {
    console.error('[diag] sax error:', e?.message || e);
  };
 (parser as any).onwarning = (w: any) => {
    console.warn('[diag] sax warning:', w);
  };

  const objectsMap = new Map<string, SpecObjectIndex>();
  const rootObjects: SpecObjectIndex[] = [];
  const attrDefMap = new Map<string, string>();
  const typeNameMap = new Map<string, string>();
  const imageRefsByObjId = new Map<string, Set<string>>();

  let toolId: string | undefined;
  let sourceToolId: string | undefined;
  let headerField: 'toolId' | 'sourceToolId' | null = null;

  let currentObject: SpecObjectIndex | null = null;
  let currentObjectLongName = '';
  let captureXml = false;
  let xmlChunks: string[] = [];
  let charOffset = 0;

  interface HierarchyContext {
    parent: SpecObjectIndex | null;
    currentNode: SpecObjectIndex | null;
  }
  let hierarchyStack: HierarchyContext[] = [{ parent: null, currentNode: null }];
  let inChildren = false;

  let currentRefId: string | null = null;
  let isInSpecObjectRef = false;

  // Attribute extraction state
  let currentAttrDefId: string | null = null;
  let currentAttrValue: string | null = null;
  let isInDefinitionRef = false;
  let isInEnumValueRef = false;
  let currentEnumValueRef = '';

  // XHTML value extraction state
  let isInXhtmlValue = false;
  let xhtmlValueChunks: string[] = [];
  let xhtmlDepth = 0;

  // Type ref extraction state
  let isInSpecObjectTypeRef = false;
  let currentTypeRef = '';

  // Diagnostic counters
  let sawSpecObject = 0;
  let sawSpecObjectType = 0;
  let sawAttributeValue = 0;

  parser.onopentag = (node: sax.Tag) => {
    const tagName = node.name.toLowerCase();
    const upperTag = node.name.toUpperCase();

    if (parser.startTagPosition != null && parser.position != null) {
      charOffset += parser.position - parser.startTagPosition;
    }

    // Header fields
    if (upperTag === 'REQ-IF-TOOL-ID') headerField = 'toolId';
    else if (upperTag === 'SOURCE-TOOL-ID') headerField = 'sourceToolId';

    // Attribute definitions: collect LONG-NAME by ID
    if (upperTag.startsWith('ATTRIBUTE-DEFINITION-') && !upperTag.endsWith('-REF')) {
      const id = node.attributes['IDENTIFIER'] || node.attributes['identifier'];
      const longName = node.attributes['LONG-NAME'] || node.attributes['long-name'] || '';
      if (id) attrDefMap.set(id, longName || id);
    }

    // SPEC-OBJECT-TYPE
    if (upperTag === 'SPEC-OBJECT-TYPE') {
      sawSpecObjectType++;
      const id = node.attributes['IDENTIFIER'] || node.attributes['identifier'];
      const longName = node.attributes['LONG-NAME'] || node.attributes['long-name'] || '';
      if (id) typeNameMap.set(id, longName || id);
    }

    // SPEC-OBJECT start
    if (tagName === 'spec-object' || tagName.endsWith(':spec-object')) {
      sawSpecObject++;
      const id = node.attributes['IDENTIFIER'] || node.attributes['identifier'] || '';
      const longName = node.attributes['LONG-NAME'] || node.attributes['long-name'] || '';
      currentObject = {
        id,
        title: '',
        offset: charOffset,
        length: 0,
        children: [],
      };
      currentObjectLongName = longName;
      captureXml = true;
      xmlChunks = [`<${node.name}${attributesToString(node.attributes)}>`];
    } else if (captureXml && currentObject) {
      xmlChunks.push(`<${node.name}${attributesToString(node.attributes)}>`);
    }

    // <img src="..."> capture
    if (upperTag === 'IMG' || upperTag.endsWith(':IMG')) {
      const src = node.attributes['src'] || node.attributes['SRC'];
      if (currentObject && src) {
        if (!imageRefsByObjId.has(currentObject.id)) {
          imageRefsByObjId.set(currentObject.id, new Set());
        }
        imageRefsByObjId.get(currentObject.id)!.add(src);
      }
    }

    // SPEC-OBJECT-TYPE-REF
    if (upperTag === 'SPEC-OBJECT-TYPE-REF') {
      isInSpecObjectTypeRef = true;
      currentTypeRef = '';
    }

    // Enter SPEC-HIERARCHY
    if (tagName === 'spec-hierarchy' || tagName.endsWith(':spec-hierarchy')) {
      const currentCtx = hierarchyStack[hierarchyStack.length - 1];
      hierarchyStack.push({
        parent: currentCtx ? currentCtx.currentNode : null,
        currentNode: null,
      });
      inChildren = false;
    }

    if (tagName === 'children' || tagName.endsWith(':children')) inChildren = true;

    if (tagName === 'object' || tagName.endsWith(':object')) {
      currentRefId = null;
      isInSpecObjectRef = false;
    }

    if (tagName === 'spec-object-ref' || tagName.endsWith(':spec-object-ref')) {
      isInSpecObjectRef = true;
      currentRefId = '';
    }

    // Attribute value handling
    if (ATTRIBUTE_VALUE_TAGS.has(upperTag)) {
      sawAttributeValue++;
      currentAttrDefId = null;
      currentAttrValue = node.attributes['THE-VALUE'] || null;

      if (upperTag === 'ATTRIBUTE-VALUE-ENUMERATION') {
        currentEnumValueRef = '';
      } else if (upperTag === 'ATTRIBUTE-VALUE-XHTML') {
        // XHTML value will be captured from a nested <THE-VALUE> element
        isInXhtmlValue = false;
        xhtmlValueChunks = [];
        xhtmlDepth = 0;
      }
    } else if (ATTRIBUTE_DEF_REF_TAGS.has(upperTag)) {
      isInDefinitionRef = true;
      currentAttrDefId = '';
    } else if (upperTag === 'ENUM-VALUE-REF') {
      isInEnumValueRef = true;
      currentEnumValueRef = '';
    }

    // Nested <THE-VALUE> inside ATTRIBUTE-VALUE-XHTML
    if (isInXhtmlValue === false && upperTag === 'THE-VALUE' &&
        currentObject && (node as any).parent && ((node as any).parent.name || '').toUpperCase() === 'ATTRIBUTE-VALUE-XHTML') {
      isInXhtmlValue = true;
      xhtmlValueChunks = [];
      xhtmlDepth = 1;
    } else if (isInXhtmlValue) {
      xhtmlDepth++;
      xhtmlValueChunks.push(`<${node.name}${attributesToString(node.attributes)}>`);
    }
  };

  parser.ontext = (text: string) => {
    if (captureXml) xmlChunks.push(text);
    if (isInSpecObjectRef && currentRefId !== null) currentRefId += text;
    if (isInDefinitionRef && currentAttrDefId !== null) currentAttrDefId += text;
    if (isInEnumValueRef) currentEnumValueRef += text;
    if (isInSpecObjectTypeRef && currentObject) currentTypeRef += text;
    if (isInXhtmlValue) xhtmlValueChunks.push(text);

    if (headerField === 'toolId') toolId = (toolId || '') + text;
    else if (headerField === 'sourceToolId') sourceToolId = (sourceToolId || '') + text;
  };

  parser.onclosetag = (tagName: string) => {
    const lowerTag = tagName.toLowerCase();
    const upperTag = tagName.toUpperCase();

    if (captureXml) xmlChunks.push(`</${tagName}>`);

    // Header fields
    if (lowerTag === 'req-if-tool-id' || lowerTag.endsWith(':req-if-tool-id')) {
      if (toolId) toolId = toolId.trim();
      headerField = null;
    }
    if (lowerTag === 'source-tool-id' || lowerTag.endsWith(':source-tool-id')) {
      if (sourceToolId) sourceToolId = sourceToolId.trim();
      headerField = null;
    }

    // Definition refs
    if (ATTRIBUTE_DEF_REF_TAGS.has(upperTag)) {
      isInDefinitionRef = false;
    }
    if (upperTag === 'ENUM-VALUE-REF') {
      isInEnumValueRef = false;
    }

    // XHTML value close
    if (isInXhtmlValue) {
      xhtmlDepth--;
      if (xhtmlDepth === 0) {
        isInXhtmlValue = false;
      } else {
        xhtmlValueChunks.push(`</${tagName}>`);
      }
    }

    // Attribute value close
    if (ATTRIBUTE_VALUE_TAGS.has(upperTag)) {
      if (currentObject && currentAttrDefId) {
        const key = currentAttrDefId.trim();
        let value = '';

        if (upperTag === 'ATTRIBUTE-VALUE-ENUMERATION') {
          value = currentEnumValueRef.trim();
        } else if (upperTag === 'ATTRIBUTE-VALUE-XHTML') {
          // Convert XHTML to plain text (strip tags)
          value = stripTags(xhtmlValueChunks.join(''));
        } else {
          value = currentAttrValue || '';
        }

        if (key) {
          if (!currentObject.rawAttributes) currentObject.rawAttributes = {};
          currentObject.rawAttributes[key] = value;
        }
      }
      currentAttrDefId = null;
      currentAttrValue = null;
      xhtmlValueChunks = [];
    }

    // SPEC-OBJECT-TYPE-REF close
    if (lowerTag === 'spec-object-type-ref' || lowerTag.endsWith(':spec-object-type-ref')) {
      if (currentObject && currentTypeRef.trim()) {
        currentObject.typeRef = currentTypeRef.trim();
      }
      isInSpecObjectTypeRef = false;
      currentTypeRef = '';
    }

    // SPEC-OBJECT close
    if (lowerTag === 'spec-object' || lowerTag.endsWith(':spec-object')) {
      if (currentObject) {
        const xmlString = xmlChunks.join('');
        currentObject.xml = xmlString;
        currentObject.length = xmlString.length;

        // Map raw attribute IDs to LONG-NAMEs
        if (currentObject.rawAttributes) {
          const newAttrs: Record<string, string> = {};
          for (const [key, value] of Object.entries(currentObject.rawAttributes)) {
            const longName = attrDefMap.get(key) || key;
            newAttrs[longName] = value;
          }
          currentObject.attributes = newAttrs;
        }

        // Resolve type ref
        if (currentObject.typeRef) {
          const tName = typeNameMap.get(currentObject.typeRef);
          if (tName) currentObject.typeName = tName;
        }

        // Determine title
        if (currentObjectLongName) {
          currentObject.title = currentObjectLongName.substring(0, 200);
        }
        if (!currentObject.title) {
          const picked = pickTitleFromAttributes(currentObject.attributes);
          if (picked) currentObject.title = picked;
        }
        if (!currentObject.title) {
          const match = xmlString.match(/>([^<]+)</);
          if (match) currentObject.title = match[1].trim().substring(0, 100);
        }

        objectsMap.set(currentObject.id, currentObject);
        currentObject = null;
        currentObjectLongName = '';
        captureXml = false;
        xmlChunks = [];
      }
    }

    if (lowerTag === 'spec-object-ref' || lowerTag.endsWith(':spec-object-ref')) {
      isInSpecObjectRef = false;
    }

    // OBJECT close
    if (lowerTag === 'object' || lowerTag.endsWith(':object')) {
      const refId = currentRefId?.trim();
      const targetObj = refId ? objectsMap.get(refId) : undefined;

      if (targetObj) {
        const currentCtx = hierarchyStack[hierarchyStack.length - 1];
        if (currentCtx) {
          if (inChildren) {
            if (currentCtx.currentNode && !currentCtx.currentNode.children.includes(targetObj)) {
              currentCtx.currentNode.children.push(targetObj);
            }
          } else {
            if (currentCtx.parent) {
              if (!currentCtx.parent.children.includes(targetObj)) {
                currentCtx.parent.children.push(targetObj);
              }
            } else {
              if (!rootObjects.includes(targetObj)) rootObjects.push(targetObj);
            }
            currentCtx.currentNode = targetObj;
          }
        }
      }
      currentRefId = null;
    }

    if (lowerTag === 'children' || lowerTag.endsWith(':children')) inChildren = false;

    if (lowerTag === 'spec-hierarchy' || lowerTag.endsWith(':spec-hierarchy')) {
      if (hierarchyStack.length > 1) hierarchyStack.pop();
      inChildren = false;
    }
  };

  parser.write(xmlText).close();

  console.log(
    '[parser] summary: SPEC-OBJECT =', sawSpecObject,
    ', SPEC-OBJECT-TYPE =', sawSpecObjectType,
    ', ATTRIBUTE-VALUE-* =', sawAttributeValue,
    ', objects in map =', objectsMap.size,
    ', toolId =', toolId
  );

  // Resolve images
  if (unzipped && reqifFileName) {
    const reqifDir = reqifFileName.includes('/')
      ? reqifFileName.substring(0, reqifFileName.lastIndexOf('/') + 1)
      : '';

    for (const obj of objectsMap.values()) {
      const refs = imageRefsByObjId.get(obj.id);
      if (!refs || refs.size === 0) continue;
      const images: { path: string; dataUrl: string }[] = [];
      for (const ref of refs) {
        const img = resolveImage(ref, unzipped, reqifDir);
        if (img) images.push(img);
      }
      if (images.length > 0) obj.images = images;
    }
  }

  // Add unreferenced objects
  const referencedIds = new Set<string>();
  const collectIds = (nodes: SpecObjectIndex[]) => {
    nodes.forEach(node => {
      referencedIds.add(node.id);
      collectIds(node.children);
    });
  };
  rootObjects.forEach(root => collectIds([root]));

  for (const obj of objectsMap.values()) {
    if (!referencedIds.has(obj.id)) rootObjects.push(obj);
  }

  rootObjects.forEach(root => assignPath(root));
  return { indexes: rootObjects, toolId, sourceToolId };
}