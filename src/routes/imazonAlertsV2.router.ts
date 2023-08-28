import Router from 'koa-router';
import logger from 'logger';
import { Context, Next } from 'koa';
import NotFound from 'errors/notFound';
import CartoDBServiceV2 from "services/cartoDBServiceV2";
import ImazonAlertsSerializerV2 from "serializers/imazonAlertsV2.serializer";


const routerV2: Router = new Router({
    prefix: '/api/v2/imazon-alerts'
});

class ImazonAlertsRouterV2 {

    static async getAdm0(ctx: Context): Promise<void> {
        logger.info('Obtaining national data');
        const data: Record<string, any> = await CartoDBServiceV2.getAdm0(
            ctx.params.iso,
            ctx.query.alertQuery as string,
            ctx.query.period as string
        );

        ctx.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static async getAdm1(ctx: Context): Promise<void> {
        logger.info('Obtaining subnational data');
        const data: Record<string, any> = await CartoDBServiceV2.getAdm1(ctx.params.iso, ctx.params.id1, ctx.query.alertQuery as string, ctx.query.period as string);
        ctx.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static async getAdm2(ctx: Context): Promise<void> {
        logger.info('Obtaining subnational data');
        const data: Record<string, any> = await CartoDBServiceV2.getAdm2(ctx.params.iso, ctx.params.id1, ctx.params.id2, ctx.query.alertQuery as string, ctx.query.period as string);
        ctx.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static async use(ctx: Context): Promise<void> {
        logger.info('Obtaining use data with name %s and id %s', ctx.params.name, ctx.params.id);
        try {
            const data: Record<string, any> = await CartoDBServiceV2.getUse(
                ctx.params.name,
                ctx.params.id,
                ctx.query.alertQuery as string,
                ctx.query.period as string,
                ctx.request.headers['x-api-key'] as string
            );
            ctx.body = ImazonAlertsSerializerV2.serialize(data);
        } catch (err) {
            if (err instanceof NotFound) {
                ctx.throw(404, 'Table not found');
                return;
            }
            throw err;
        }
    }

    static async wdpa(ctx: Context): Promise<void> {
        logger.info('Obtaining wpda data with id %s', ctx.params.id);
        const data: Record<string, any> = await CartoDBServiceV2.getWdpa(
            ctx.params.id,
            ctx.query.alertQuery as string,
            ctx.query.period as string,
            ctx.request.headers['x-api-key'] as string
        );
        ctx.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static async world(ctx: Context): Promise<void> {
        logger.info('Obtaining world data');
        ctx.assert(ctx.query.geostore, 400, 'GeoJSON param required');
        try {
            const data: Record<string, any> = await CartoDBServiceV2.getWorld(
                ctx.query.geostore as string,
                ctx.query.alertQuery as string,
                ctx.query.period as string,
                ctx.request.headers['x-api-key'] as string
            );

            ctx.body = ImazonAlertsSerializerV2.serialize(data);
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
            const data: Record<string, any> = await CartoDBServiceV2.getWorldWithGeojson(
                ImazonAlertsRouterV2.checkGeojson((ctx.request.body as Record<string, any>).geojson),
                ctx.query.alertQuery as string,
                ctx.query.period as string
            );

            ctx.body = ImazonAlertsSerializerV2.serialize(data);
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
            const data: Array<Record<string, any>> = await CartoDBServiceV2.latest();

            ctx.body = ImazonAlertsSerializerV2.serializeLatest(data);
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


routerV2.get('/admin/:iso', isCached, ImazonAlertsRouterV2.getAdm0);
routerV2.get('/admin/:iso/:id1', isCached, ImazonAlertsRouterV2.getAdm1);
routerV2.get('/admin/:iso/:id1/:id2', isCached, ImazonAlertsRouterV2.getAdm2);
routerV2.get('/use/:name/:id', isCached, ImazonAlertsRouterV2.use);
routerV2.get('/wdpa/:id', isCached, ImazonAlertsRouterV2.wdpa);
routerV2.get('/', isCached, ImazonAlertsRouterV2.world);
routerV2.post('/', ImazonAlertsRouterV2.worldWithGeojson);
routerV2.get('/latest', isCached, ImazonAlertsRouterV2.latest);


export default routerV2;
