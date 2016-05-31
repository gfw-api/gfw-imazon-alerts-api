'use strict';

var logger = require('logger');
var JSONAPISerializer = require('jsonapi-serializer').Serializer;
var imazonAlertsSerializer = new JSONAPISerializer('imazon-alerts', {
    attributes: ['value','downloadUrls'],
    typeForAttribute: function (attribute, record) {
        return attribute;
    },
    downloadUrls:{
        attributes: ['csv', 'geojson', 'kml', 'shp', 'svg']
    },
    value: {
        attributes: ['data_type', 'value', 'min_date', 'max_date']
    }
});
var imazonLatestSerializer = new JSONAPISerializer('imazon-latest', {
    attributes: ['date'],
    typeForAttribute: function (attribute, record) {
        return attribute;
    }
});

class ImazonAlertsSerializer {

  static serialize(data) {
    return imazonAlertsSerializer.serialize(data);
  }

  static serializeLatest(data) {
    return imazonLatestSerializer.serialize(data);
  }
}

module.exports = ImazonAlertsSerializer;
