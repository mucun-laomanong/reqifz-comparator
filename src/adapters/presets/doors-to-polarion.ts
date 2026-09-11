import { AdapterConfig } from '../types';

// Rules for comparing IBM DOORS exports against Siemens Polarion exports.
const doorsToPolarion: AdapterConfig = {
  id: 'doors-to-polarion',
  name: 'DOORS → Polarion',
  description: 'IBM DOORS Classic / DOORS Next export vs Siemens Polarion export',
  extends: 'generic',

  detection: {
    // Level 1 (high confidence): tool-id fields
    sourceToolIdPattern: 'DOORS',
    targetToolIdPattern: 'Polarion',
    // Level 2 (medium confidence): file names
    sourceToolPattern: 'doors',
    targetToolPattern: 'polarion',
    // Level 3 (low confidence): attribute fingerprints
    sourceAttributePattern: 'ReqIF\\.ForeignID|IE PUID|Object Heading',
    targetAttributePattern: 'reqif\\.(name|text)|Work ?Item',
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
      'ReqIF.ChapterName': 'Title',
      'IE PUID': 'PUID',
      Status: 'Status',
    },
    preferredSource: 'a',
  },

  typeMapping: {
    Date: { targetType: 'String', format: 'YYYY-MM-DD' },
  },

  ignore: {
    attributes: [
      'LAST-CHANGE',
      'TOOL-ID',
      'ReqIF.ForeignCreatedBy',
      'ReqIF.ForeignModifiedBy',
      'ReqIF.ForeignCreatedOn',
      'ReqIF.ForeignModifiedOn',
    ],
    ignoreEmptyVsMissing: true,
  },

  valueCompare: {
    caseSensitive: false,
    trimWhitespace: true,
    normalizeWhitespace: true,
  },
};

export default doorsToPolarion;