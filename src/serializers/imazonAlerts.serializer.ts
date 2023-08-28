import { Serializer } from 'jsonapi-serializer';

const imazonAlertsSerializer: Serializer = new Serializer('imazon-alerts', {
    attributes: ['value', 'downloadUrls', 'area_ha'],
    typeForAttribute: (attribute: string) => attribute,

    downloadUrls: {
        attributes: ['csv', 'geojson', 'kml', 'shp', 'svg']
    },
    value: {
        attributes: ['data_type', 'value', 'min_date', 'max_date']
    },
    keyForAttribute: 'camelCase'
});
const imazonLatestSerializer: Serializer = new Serializer('imazon-latest', {
    attributes: ['date'],
    typeForAttribute: (attribute: string) => attribute,
});

class ImazonAlertsSerializer {

    static serialize(data: Record<string, any>): Record<string, any> {
        return imazonAlertsSerializer.serialize(data);
    }

    static serializeLatest(data: Record<string, any>): Record<string, any> {
        return imazonLatestSerializer.serialize(data);
    }

}

export default ImazonAlertsSerializer;
