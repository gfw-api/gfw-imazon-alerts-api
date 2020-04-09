const JSONAPISerializer = require('jsonapi-serializer').Serializer;

const imazonAlertsSerializer = new JSONAPISerializer('imazon-alerts', {
    attributes: ['value', 'downloadUrls', 'area_ha'],
    typeForAttribute(attribute) {
        return attribute;
    },
    downloadUrls: {
        attributes: ['csv', 'geojson', 'kml', 'shp', 'svg']
    },
    value: {
        attributes: ['data_type', 'value', 'min_date', 'max_date']
    },
    keyForAttribute: 'camelCase'
});
const imazonLatestSerializer = new JSONAPISerializer('imazon-latest', {
    attributes: ['date'],
    typeForAttribute(attribute) {
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
