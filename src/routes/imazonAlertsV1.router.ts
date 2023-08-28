import Router from 'koa-router';
import logger from 'logger';
import { Context, Next } from 'koa';
import CartoDBService from 'services/cartoDBService';
import NotFound from 'errors/notFound';
import ImazonAlertsSerializer from "serializers/imazonAlerts.serializer";


const routerV1: Router = new Router({
    prefix: '/api/v1/imazon-alerts'
});

class ImazonAlertsRouterV1 {

    static async getNational(ctx: Context): Promise<void> {
        logger.info('Obtaining national data');
        const data: Record<string, any> = await CartoDBService.getNational(
            ctx.params.iso,
            ctx.query.alertQuery as string,
            ctx.query.period as string,
            ctx.request.headers['x-api-key'] as string);

        ctx.response.body = ImazonAlertsSerializer.serialize(data);
    }

    static async getSubnational(ctx: Context): Promise<void> {
        logger.info('Obtaining subnational data');
        const data: Record<string, any> = await CartoDBService.getSubnational(
            ctx.params.iso,
            ctx.params.id1,
            ctx.query.alertQuery as string,
            ctx.query.period as string,
            ctx.request.headers['x-api-key'] as string);
        ctx.response.body = ImazonAlertsSerializer.serialize(data);
    }

    static async use(ctx: Context): Promise<void> {
        logger.info('Obtaining use data with name %s and id %s', ctx.params.name, ctx.params.id);
        let useTable: string;
        switch (ctx.params.name) {

            case 'mining':
                useTable = 'gfw_mining';
                break;
            case 'oilpalm':
                useTable = 'gfw_oil_palm';
                break;
            case 'fiber':
                useTable = 'gfw_wood_fiber';
                break;
            case 'logging':
                useTable = 'gfw_logging';
                break;
            default:
                useTable = ctx.params.name;

        }
        if (!useTable) {
            useTable = ctx.params.name;
        }
        const data: Record<string, any> = await CartoDBService.getUse(
            ctx.params.name,
            useTable,
            ctx.params.id,
            ctx.query.alertQuery as string,
            ctx.query.period as string,
            ctx.request.headers['x-api-key'] as string
        );
        ctx.response.body = ImazonAlertsSerializer.serialize(data);

    }

    static async wdpa(ctx: Context): Promise<void> {
        logger.info('Obtaining wpda data with id %s', ctx.params.id);
        const data: Record<string, any> = await CartoDBService.getWdpa(
            ctx.params.id,
            ctx.query.alertQuery as string,
            ctx.query.period as string,
            ctx.request.headers['x-api-key'] as string
        );
        ctx.response.body = ImazonAlertsSerializer.serialize(data);
    }

    static async world(ctx: Context): Promise<void> {
        logger.info('Obtaining world data');
        ctx.assert(ctx.query.geostore, 400, 'GeoJSON param required');
        try {
            const data: Record<string, any> = await CartoDBService.getWorld(
                ctx.query.geostore as string,
                ctx.query.alertQuery as string,
                ctx.query.period as string,
                ctx.request.headers['x-api-key'] as string
            );

            ctx.response.body = ImazonAlertsSerializer.serialize(data);
        } catch (err) {
            if (err instanceof NotFound) {
                ctx.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }
    }

    static checkGeojson(geojson: Record<string, any>): Record<string, any> {
        if (geojson.type.toLowerCase() === 'polygon') {
            return {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: geojson
                }]
            };
        }
        if (geojson.type.toLowerCase() === 'feature') {
            return {
                type: 'FeatureCollection',
                features: [geojson]
            };
        }
        return geojson;
    }

    static async worldWithGeojson(ctx: Context): Promise<void> {
        logger.info('Obtaining world data with geostore');
        ctx.assert((ctx.request.body as Record<string, any>).geojson, 400, 'GeoJSON param required');
        try {
            const data: Record<string, any> = await CartoDBService.getWorldWithGeojson(
                ImazonAlertsRouterV1.checkGeojson((ctx.request.body as Record<string, any>).geojson),
                ctx.query.alertQuery as string,
                ctx.query.period as string
            );

            ctx.response.body = ImazonAlertsSerializer.serialize(data);
        } catch (err) {
            if (err instanceof NotFound) {
                ctx.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

    static async latest(ctx: Context): Promise<void> {
        logger.info('Obtaining latest data');
        try {
            const data: void | any[] = await CartoDBService.latest(ctx.query.limit as string);

            ctx.response.body = ImazonAlertsSerializer.serializeLatest(data as Record<string, any>);
        } catch (err) {
            if (err instanceof NotFound) {
                ctx.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

}

const isCached = async (ctx: Context, next: Next): Promise<void> => {
    if (await ctx.cashed()) {
        return;
    }
    await next();
};


routerV1.get('/admin/:iso', isCached, ImazonAlertsRouterV1.getNational);
routerV1.get('/admin/:iso/:id1', isCached, ImazonAlertsRouterV1.getSubnational);
routerV1.get('/use/:name/:id', isCached, ImazonAlertsRouterV1.use);
routerV1.get('/wdpa/:id', isCached, ImazonAlertsRouterV1.wdpa);
routerV1.get('/', isCached, ImazonAlertsRouterV1.world);
routerV1.post('/', ImazonAlertsRouterV1.worldWithGeojson);
routerV1.get('/latest', isCached, ImazonAlertsRouterV1.latest);


export default routerV1;
