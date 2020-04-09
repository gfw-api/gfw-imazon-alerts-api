const JSONAPISerializer = require('jsonapi-serializer').Serializer;

const imazonAlertsSerializerV2 = new JSONAPISerializer('imazon-alerts', {
    attributes: ['value', 'downloadUrls', 'area_ha'],
    typeForAttribute(attribute) {
        return attribute;
    },
    downloadUrls: {
        attributes: ['csv', 'json', 'kml', 'shp', 'svg']
    },
    value: {
        attributes: ['label', 'value', 'unit', 'min_date', 'max_date']
    },
    keyForAttribute: 'camelCase'
});
const imazonLatestSerializer = new JSONAPISerializer('imazon-latest', {
    attributes: ['latest'],
    typeForAttribute(attribute) {
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
