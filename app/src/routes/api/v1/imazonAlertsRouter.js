'use strict';

var Router = require('koa-router');
var logger = require('logger');
var CartoDBService = require('services/cartoDBService');
var NotFound = require('errors/notFound');
var ImazonAlertsSerializer = require('serializers/imazonAlertsSerializer');


var router = new Router({
    prefix: '/imazon-alerts'
});

class ImazonAlertsRouter {
    static * getNational() {
        logger.info('Obtaining national data');
        let data = yield CartoDBService.getNational(this.params.iso, this.query.alertQuery, this.query.period);

        this.body = ImazonAlertsSerializer.serialize(data);
    }

    static * getSubnational() {
        logger.info('Obtaining subnational data');
        let data = yield CartoDBService.getSubnational(this.params.iso, this.params.id1, this.query.alertQuery, this.query.period);
        this.body = ImazonAlertsSerializer.serialize(data);
    }

    static * use() {
        logger.info('Obtaining use data with name %s and id %s', this.params.name, this.params.id);
        let useTable = null;
        switch (this.params.name) {
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
                useTable = this.params.name;
        }
        if (!useTable) {
            tableName = this.params.name;
        }
        let data = yield CartoDBService.getUse(this.params.name, useTable, this.params.id, this.query.alertQuery, this.query.period);
        this.body = ImazonAlertsSerializer.serialize(data);

    }

    static * wdpa() {
        logger.info('Obtaining wpda data with id %s', this.params.id);
        let data = yield CartoDBService.getWdpa(this.params.id, this.query.alertQuery, this.query.period);
        this.body = ImazonAlertsSerializer.serialize(data);
    }

    static * world() {
        logger.info('Obtaining world data');
        this.assert(this.query.geostore, 400, 'GeoJSON param required');
        try{
            let data = yield CartoDBService.getWorld(this.query.geostore, this.query.alertQuery, this.query.period);

            this.body = ImazonAlertsSerializer.serialize(data);
        } catch(err){
            if(err instanceof NotFound){
                this.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

    static checkGeojson(geojson) {
        if (geojson.type.toLowerCase() === 'polygon'){
            return {
                type: 'FeatureCollection',
                features: [{
                    type: 'Feature',
                    geometry: geojson
                }]
            };
        } else if (geojson.type.toLowerCase() === 'feature') {
            return {
                type: 'FeatureCollection',
                features: [geojson]
            };
        } 
        return geojson;
    }

    static * worldWithGeojson() {
        logger.info('Obtaining world data with geostore');
        this.assert(this.request.body.geojson, 400, 'GeoJSON param required');
        try{            
            let data = yield CartoDBService.getWorldWithGeojson(ImazonAlertsRouter.checkGeojson(this.request.body.geojson), this.query.alertQuery, this.query.period);

            this.body = ImazonAlertsSerializer.serialize(data);
        } catch(err){
            if(err instanceof NotFound){
                this.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

    static * latest() {
        logger.info('Obtaining latest data');
        try{
            let data = yield CartoDBService.latest(this.query.limit);

            this.body = ImazonAlertsSerializer.serializeLatest(data);
        } catch(err){
            if(err instanceof NotFound){
                this.throw(404, 'Geostore not found');
                return;
            }
            throw err;
        }

    }

}

var isCached = function*(next) {
    if (yield this.cashed()) {
        return;
    }
    yield next;
};



router.get('/admin/:iso', isCached, ImazonAlertsRouter.getNational);
router.get('/admin/:iso/:id1', isCached, ImazonAlertsRouter.getSubnational);
router.get('/use/:name/:id', isCached, ImazonAlertsRouter.use);
router.get('/wdpa/:id', isCached, ImazonAlertsRouter.wdpa);
router.get('/', isCached, ImazonAlertsRouter.world);
router.post('/', ImazonAlertsRouter.worldWithGeojson);
router.get('/latest', isCached, ImazonAlertsRouter.latest);


module.exports = router;
