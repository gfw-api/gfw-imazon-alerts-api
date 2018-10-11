
'use strict';

var logger = require('logger');
var JSONAPISerializer = require('jsonapi-serializer').Serializer;
var imazonAlertsSerializerV2 = new JSONAPISerializer('imazon-alerts', {
    attributes: ['value','downloadUrls', 'area_ha'],
    typeForAttribute: function (attribute, record) {
        return attribute;
    },
    downloadUrls:{
        attributes: ['csv', 'json', 'kml', 'shp', 'svg']
    },
    value: {
        attributes: ['label', 'value', 'unit', 'min_date', 'max_date']
    },
    keyForAttribute: 'camelCase'
});
var imazonLatestSerializer = new JSONAPISerializer('imazon-latest', {
    attributes: ['latest'],
    typeForAttribute: function (attribute, record) {
        return attribute;
    }
});

class ImazonAlertsSerializerV2 {

  static serialize(data) {
    return imazonAlertsSerializerV2.serialize(data);
  }

  static serializeLatest(data) {
    return imazonLatestSerializer.serialize(data);
  }
}

module.exports = ImazonAlertsSerializerV2;
