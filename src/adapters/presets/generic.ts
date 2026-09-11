import { AdapterConfig } from '../types';

// Equivalent to the previous `compareRoots` behavior:
// match by IDENTIFIER, no attribute mapping, no ignores.
const generic: AdapterConfig = {
  id: 'generic',
  name: 'Generic (no mapping)',
  description:
    'Match by IDENTIFIER and do not map any attributes. Suitable for two files exported by the same tool.',
  idMatching: { strategy: 'identifier' },
  attributeMapping: { map: {} },
  ignore: {
    attributes: [],
    ignoreEmptyVsMissing: true,
  },
  valueCompare: {
    caseSensitive: false,
    trimWhitespace: true,
  },
};

export default generic;