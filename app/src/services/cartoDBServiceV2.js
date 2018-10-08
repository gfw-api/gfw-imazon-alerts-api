'use strict';
const logger = require('logger');
const path = require('path');
const config = require('config');
const CartoDB = require('cartodb');
const Mustache = require('mustache');
const NotFound = require('errors/notFound');
const GeostoreService = require('services/geostoreService');

const WORLD = `WITH poly AS (SELECT * FROM ST_Transform(ST_SimplifyPreserveTopology(ST_SetSRID(ST_MakeValid(ST_GeomFromGeoJSON('{{{geojson}}}')), 4326), 0.01), 3857) geojson)
             SELECT data_type, count(*) AS value
             FROM imazon_sad i, poly        WHERE i.date >= '{{begin}}'::date
               AND i.date <= '{{end}}'::date  and st_intersects(poly.geojson, i.the_geom_webmercator) group by data_type `;

const ISO = `
        with p as (SELECT st_makevalid(st_simplify(the_geom, {{simplify}})) as the_geom, area_ha FROM gadm36_countries WHERE iso = UPPER('{{iso}}'))
        SELECT data_type,
            sum(ST_Area(i.the_geom)/(100*100)) AS value, area_ha
            {{additionalSelect}}
        FROM imazon_sad i right join p on st_intersects(i.the_geom, p.the_geom)
        WHERE i.date >= '{{begin}}'::date
            AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const ID1 = `with p as (SELECT st_makevalid(st_simplify(the_geom, {{simplify}})) as the_geom, area_ha FROM gadm36_adm1 WHERE iso = UPPER('{{iso}}') AND gid_1 = '{{id1}}')
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom, p.the_geom))/(10000)) AS value, area_ha
        FROM imazon_sad i right join p on st_intersects(i.the_geom, p.the_geom)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const ID2 = `with p as (SELECT st_makevalid(st_simplify(the_geom, {{simplify}})) as the_geom, area_ha FROM gadm36_adm2 WHERE iso = UPPER('{{iso}}') AND gid_1 = '{{id1}}' AND gid_2 = '{{id2}}')
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom, p.the_geom))/(10000)) AS value, area_ha
        FROM imazon_sad i right join p on st_intersects(i.the_geom, p.the_geom)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const USE = `SELECT data_type, SUM(ST_Area(ST_Intersection(
                i.the_geom_webmercator,
                p.the_geom_webmercator))/(10000)) AS value
               {{additionalSelect}}
        FROM {{useTable}} p inner join imazon_sad i
            on ST_Intersects(
                i.the_geom_webmercator,
                p.the_geom_webmercator)
            AND i.date >= '{{begin}}'::date
            AND i.date <= '{{end}}'::date
            where p.cartodb_id = {{pid}}
        GROUP BY data_type`;

const WDPA = `WITH  p as ( SELECT
            CASE WHEN marine::numeric = 2
             THEN null
            WHEN ST_NPoints(the_geom_webmercator)<=18000 THEN the_geom_webmercator
            WHEN ST_NPoints(the_geom_webmercator)
            BETWEEN 18000 AND 50000
            THEN ST_RemoveRepeatedPoints(the_geom_webmercator, 100)
            ELSE ST_RemoveRepeatedPoints(the_geom_webmercator, 1000)
            END as the_geom_webmercator, gis_area*100 as area_ha FROM wdpa_protected_areas where wdpaid={{wdpaid}})
            SELECT data_type, SUM(ST_Area(ST_Intersection(
                            i.the_geom_webmercator,
                            p.the_geom_webmercator))/(10000)) AS value
            {{additionalSelect}}
            FROM p
            inner join imazon_sad i
            on st_intersects(i.the_geom_webmercator,
                            p.the_geom_webmercator)
            and i.date >= '{{begin}}'::date
                        AND i.date <= '{{end}}'::date
            GROUP BY data_type`;

const LATEST = `SELECT MAX(date) AS latest
    FROM imazon_sad`;

const MIN_MAX_DATE_SQL = ', MIN(date) as min_date, MAX(date) as max_date ';

const GIDAREA = `select area_ha FROM {{table}} WHERE gid_{{level}} = '{{gid}}'`;

var executeThunk = function (client, sql, params) {
    return function (callback) {
        logger.info(Mustache.render(sql, params));
        client.execute(sql, params).done(function (data) {
            callback(null, data);
        }).error(function (err) {
            callback(err, null);
        });
    };
};

const routeToGid = function (adm0, adm1, adm2) {
    return {
        adm0,
        adm1: adm1 ? `${adm0}.${adm1}_1` : null,
        adm2: adm2 ? `${adm0}.${adm1}.${adm2}_1` : null
    };
};

let getToday = function () {
    let today = new Date();
    return `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}-${today.getDate().toString()}`;
};

let defaultDate = function () {
    let to = getToday();
    let from = '2008-04-30';
    return from + ',' + to;
};

const getSimplify = (iso) => {
    let thresh = 0.005;
    if (iso) {
        const bigCountries = ['USA', 'RUS', 'CAN', 'CHN', 'BRA', 'IDN'];
        thresh = bigCountries.includes(iso) ? 0.05 : 0.005;
    }
    return thresh;
};

class CartoDBServiceV2 {

    constructor() {
        this.client = new CartoDB.SQL({
            user: config.get('cartoDB.user')
        });
        this.apiUrl = config.get('cartoDB.apiUrl');
    }

    getDownloadUrls(query, params) {
        try {
            let formats = ['csv', 'geojson', 'kml', 'shp', 'svg'];
            let download = {};
            let queryFinal = Mustache.render(query, params);
            queryFinal = queryFinal.replace(MIN_MAX_DATE_SQL, '');
            queryFinal = queryFinal.replace('SELECT data_type,', 'SELECT i.data_type, i.the_geom,');
            queryFinal = queryFinal.replace('GROUP BY data_type', 'GROUP BY data_type, i.the_geom');
            queryFinal = encodeURIComponent(queryFinal);
            for (let i = 0, length = formats.length; i < length; i++) {
                download[formats[i]] = this.apiUrl + '?q=' + queryFinal + '&format=' + formats[i];
            }
            return download;
        } catch (err) {
            logger.error(err);
        }
    }


    * getAdm0(iso, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining national of iso %s', iso);
        const gid = routeToGid(iso);
        const simplify = getSimplify(iso);
        let periods = period.split(',');
        let params = {
            iso: gid.adm0,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        if (iso === 'BRA') {
            let data = yield executeThunk(this.client, ISO, params);
            let result = {};
            result.downloadUrls = this.getDownloadUrls(ISO, params);
            result.id = params.iso;
            result.period = period;
            if (data && data.rows && data.rows.length) {
                result.area_ha = data.rows[0].area_ha;
                result.value = data.rows.map(el => ({label: el.data_type === 'defor' ? 'deforestation' : 'degraded', value: el.value, unit: 'ha'}));
                return result;
            }
            let area = yield executeThunk(this.client, GIDAREA, { table: 'gadm36_countries', level: '0', gid: params.id0 });
            if (area && area.rows && area.rows.length) {
                let areaHa = area.rows && area.rows[0] || null;
                result.area_ha = areaHa.area_ha;
                result.value = null;
                return result;
            }
        }
        return null;
    }

    * getAdm1(iso, id1, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining subnational of iso %s and id1', iso, id1);
        const gid = routeToGid(iso, id1);
        const simplify = getSimplify(iso) / 100;
        let periods = period.split(',');
        let params = {
            iso: gid.adm0,
            id1: gid.adm1,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        let data = yield executeThunk(this.client, ID1, params);
        let result = {};
        result.downloadUrls = this.getDownloadUrls(ID1, params);
        result.id = params.iso;
        result.period = period;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map(el => ({label: el.data_type === 'defor' ? 'deforestation' : 'degraded', value: el.value, unit: 'ha'}));            
            return result;
        }
        let area = yield executeThunk(this.client, GIDAREA, { table: 'gadm36_adm1', level: '1', gid: params.id1 });
        if (area && area.rows && area.rows.length) {
            let areaHa = area.rows && area.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.value = null;
            return result;
        }
        return null;
    }

    * getAdm2(iso, id1, id2, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining regional data', iso, id1, id2);
        const gid = routeToGid(iso, id1, id2);
        const simplify = getSimplify(iso) / 100;
        let periods = period.split(',');
        let params = {
            iso: gid.adm0,
            id1: gid.adm1,
            id2: gid.adm2,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        let data = yield executeThunk(this.client, ID2, params);
        let result = {};
        result.downloadUrls = this.getDownloadUrls(ID2, params);
        result.id = params.iso;
        result.period = period;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map(el => ({label: el.data_type === 'defor' ? 'deforestation' : 'degraded', value: el.value, unit: 'ha'}));
            return result;
        }
        let area = yield executeThunk(this.client, GIDAREA, { table: 'gadm36_adm2', level: '2', gid: params.id2 });
        if (area && area.rows && area.rows.length) {
            let areaHa = area.rows && area.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.value = null;
            return result;
        }
        return null;
    }

    * getUse(useName, useTable, id, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining use with id %s', id);
        let periods = period.split(',');
        let params = {
            useTable: useTable,
            pid: id,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }

        const geostore = yield GeostoreService.getGeostoreByUse(useName, id);
        let data = yield executeThunk(this.client, USE, params);
        if (geostore) {
            if (data.rows && data.rows.length > 0 && data.rows[0].data_type !== null) {
                let result = {
                    value: data.rows
                };
                result.area_ha = geostore.areaHa;
                result.downloadUrls = this.getDownloadUrls(USE, params);
                return result;
            } else {
                return {
                    value: [],
                    area_ha: geostore.areaHa
                };
            }
        }
        return null;
    }

    * getWdpa(wdpaid, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining wpda of id %s', wdpaid);
        let periods = period.split(',');
        let params = {
            wdpaid: wdpaid,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const geostore = yield GeostoreService.getGeostoreByWdpa(wdpaid);
        let data = yield executeThunk(this.client, WDPA, params);
        if (geostore) {
            if (data.rows) {
                let result = {
                    value: data.rows
                };
                result.area_ha = geostore.areaHa;
                result.downloadUrls = this.getDownloadUrls(WDPA, params);
                return result;
            } else {
                return {
                    value: [],
                    area_ha: geostore.areaHa
                };
            }
        }
        return null;
    }

    * getWorld(hashGeoStore, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining world with hashGeoStore %s', hashGeoStore);

        const geostore = yield GeostoreService.getGeostoreByHash(hashGeoStore);
        if (geostore && geostore.geojson) {
            logger.debug('Executing query in cartodb with geojson', geostore.geojson);
            let periods = period.split(',');
            let params = {
                geojson: JSON.stringify(geostore.geojson.features[0].geometry),
                begin: periods[0],
                end: periods[1]
            };
            if (alertQuery) {
                params.additionalSelect = MIN_MAX_DATE_SQL;
            }
            let data = yield executeThunk(this.client, WORLD, params);
            if (data.rows) {
                let result = {
                    value: data.rows
                };
                result.area_ha = geostore.areaHa;
                result.downloadUrls = this.getDownloadUrls(WORLD, params);
                return result;
            }
            return null;
        }
        throw new NotFound('Geostore not found');
    }

    * getWorldWithGeojson(geojson, alertQuery, period = defaultDate()) {
        logger.debug('Executing query in cartodb with geojson', geojson);
        let periods = period.split(',');
        let params = {
            geojson: JSON.stringify(geojson.features[0].geometry),
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        let data = yield executeThunk(this.client, WORLD, params);
        if (data.rows) {
            let result = {
                value: data.rows
            };
            if (data.rows.length > 0) {
                result.area_ha = data.rows[0].area_ha;
            }
            result.downloadUrls = this.getDownloadUrls(ISO, params);
            return result;
        }
        return null;
    }
    
    * latest() {
    logger.debug('Obtaining latest date');
    let data = yield executeThunk(this.client, LATEST);
    if (data && data.rows && data.rows.length) {
        let result = data.rows;
        return result;
    }
    return null;
}
}

module.exports = new CartoDBServiceV2();
