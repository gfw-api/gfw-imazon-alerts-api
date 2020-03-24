const Router = require('koa-router');
const logger = require('logger');
const CartoDBServiceV2 = require('services/cartoDBServiceV2');
const NotFound = require('errors/notFound');
const ImazonAlertsSerializerV2 = require('serializers/imazonAlertsSerializerV2');


const router = new Router({
    prefix: '/imazon-alerts'
});

class ImazonAlertsRouterV2 {

    static* getAdm0() {
        logger.info('Obtaining national data');
        const data = yield CartoDBServiceV2.getAdm0(this.params.iso, this.query.alertQuery, this.query.period);

        this.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static* getAdm1() {
        logger.info('Obtaining subnational data');
        const data = yield CartoDBServiceV2.getAdm1(this.params.iso, this.params.id1, this.query.alertQuery, this.query.period);
        this.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static* getAdm2() {
        logger.info('Obtaining subnational data');
        const data = yield CartoDBServiceV2.getAdm2(this.params.iso, this.params.id1, this.params.id2, this.query.alertQuery, this.query.period);
        this.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static* use() {
        logger.info('Obtaining use data with name %s and id %s', this.params.name, this.params.id);
        try {
            const data = yield CartoDBServiceV2.getUse(this.params.name, this.params.id, this.query.alertQuery, this.query.period);
            this.body = ImazonAlertsSerializerV2.serialize(data);
        } catch (err) {
            if (err instanceof NotFound) {
                this.throw(404, 'Table not found');
                return;
            }
            throw err;
        }
    }

    static* wdpa() {
        logger.info('Obtaining wpda data with id %s', this.params.id);
        const data = yield CartoDBServiceV2.getWdpa(this.params.id, this.query.alertQuery, this.query.period);
        this.body = ImazonAlertsSerializerV2.serialize(data);
    }

    static* world() {
        logger.info('Obtaining world data');
        this.assert(this.query.geostore, 400, 'GeoJSON param required');
        try {
            const data = yield CartoDBServiceV2.getWorld(this.query.geostore, this.query.alertQuery, this.query.period);

            this.body = ImazonAlertsSerializerV2.serialize(data);
        } catch (err) {
            if (err instanceof NotFound) {
                this.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

    static checkGeojson(geojson) {
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

    static* worldWithGeojson() {
        logger.info('Obtaining world data with geostore');
        this.assert(this.request.body.geojson, 400, 'GeoJSON param required');
        try {
            const data = yield CartoDBServiceV2.getWorldWithGeojson(ImazonAlertsRouterV2.checkGeojson(this.request.body.geojson), this.query.alertQuery, this.query.period);

            this.body = ImazonAlertsSerializerV2.serialize(data);
        } catch (err) {
            if (err instanceof NotFound) {
                this.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

    static* latest() {
        logger.info('Obtaining latest data');
        try {
            const data = yield CartoDBServiceV2.latest(this.query.limit);

            this.body = ImazonAlertsSerializerV2.serializeLatest(data);
        } catch (err) {
            if (err instanceof NotFound) {
                this.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

}

const isCached = function* isCached(next) {
    if (yield this.cashed()) {
        return;
    }
    yield next;
};


router.get('/admin/:iso', isCached, ImazonAlertsRouterV2.getAdm0);
router.get('/admin/:iso/:id1', isCached, ImazonAlertsRouterV2.getAdm1);
router.get('/admin/:iso/:id1/:id2', isCached, ImazonAlertsRouterV2.getAdm2);
router.get('/use/:name/:id', isCached, ImazonAlertsRouterV2.use);
router.get('/wdpa/:id', isCached, ImazonAlertsRouterV2.wdpa);
router.get('/', isCached, ImazonAlertsRouterV2.world);
router.post('/', ImazonAlertsRouterV2.worldWithGeojson);
router.get('/latest', isCached, ImazonAlertsRouterV2.latest);


module.exports = router;
