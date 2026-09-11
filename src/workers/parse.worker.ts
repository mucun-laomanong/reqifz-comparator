import { parseReqifz } from '../core/parser';

self.onmessage = async (e) => {
  const arrayBuffer = e.data;
  try {
    // parseReqifz now returns { indexes, toolId, sourceToolId }
    const result = parseReqifz(arrayBuffer);
    console.log(
      'Worker parsed:',
      result.indexes.length,
      'objects; toolId =',
      result.toolId,
      '; sourceToolId =',
      result.sourceToolId
    );
    (self as any).postMessage({
      success: true,
      indexes: result.indexes,
      toolId: result.toolId,
      sourceToolId: result.sourceToolId,
    });
  } catch (error: any) {
    console.error('Worker parse error:', error);
    (self as any).postMessage({
      success: false,
      error: error?.message || String(error),
    });
  }
};