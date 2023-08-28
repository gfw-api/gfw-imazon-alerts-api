import { Serializer } from 'jsonapi-serializer';

const imazonAlertsSerializerV2: Serializer = new Serializer('imazon-alerts', {
    attributes: ['value', 'downloadUrls', 'area_ha'],
    typeForAttribute: (attribute: string) => attribute,
    downloadUrls: {
        attributes: ['csv', 'json', 'kml', 'shp', 'svg']
    },
    value: {
        attributes: ['label', 'value', 'unit', 'min_date', 'max_date']
    },
    keyForAttribute: 'camelCase'
});
const imazonLatestSerializer: Serializer = new Serializer('imazon-latest', {
    attributes: ['latest'],
    typeForAttribute: (attribute: string) => attribute
});

class ImazonAlertsSerializerV2 {

    static serialize(data: Record<string, any>): Record<string, any> {
        return imazonAlertsSerializerV2.serialize(data);
    }

    static serializeLatest(data: Record<string, any>): Record<string, any> {
        return imazonLatestSerializer.serialize(data);
    }

}

export default ImazonAlertsSerializerV2
