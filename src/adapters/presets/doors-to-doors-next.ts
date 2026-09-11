import { AdapterConfig } from '../types';

// Rules for comparing DOORS Classic exports against DOORS Next exports.
const doorsToDoorsNext: AdapterConfig = {
  id: 'doors-to-doors-next',
  name: 'DOORS Classic → DOORS Next',
  extends: 'generic',

  detection: {
    sourceToolIdPattern: 'DOORS(?! Next)',
    targetToolIdPattern: 'DOORS Next|DOORS\\.Next',
    sourceToolPattern: 'doors[-_]?(classic|9)',
    targetToolPattern: 'doors[-_]?next|dng',
    sourceAttributePattern: 'Object Heading|Object Text|IE PUID',
    targetAttributePattern: 'ReqIF\\.(Name|Text|ChapterName)',
  },

  idMatching: {
    strategy: 'attribute',
    attributeName: 'ReqIF.ForeignID',
    fallback: { strategy: 'identifier' },
  },

  attributeMapping: {
    map: {
      'ReqIF.Name': 'Title',
      'ReqIF.Text': 'Description',
    },
    preferredSource: 'a',
  },

  ignore: {
    attributes: [
      'LAST-CHANGE',
      'TOOL-ID',
      'ReqIF.ForeignCreatedBy',
      'ReqIF.ForeignModifiedBy',
    ],
    ignoreEmptyVsMissing: true,
  },

  valueCompare: {
    caseSensitive: false,
    trimWhitespace: true,
    normalizeWhitespace: false,
  },
};

export default doorsToDoorsNext;