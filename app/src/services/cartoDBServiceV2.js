/* eslint-disable no-mixed-operators */
const logger = require('logger');
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
        with p as (SELECT st_makevalid(st_simplify(the_geom_webmercator, 5)) as the_geom_webmercator, area_ha FROM gadm36_countries WHERE iso = UPPER('{{iso}}'))
        SELECT data_type,
            sum(ST_Area(i.the_geom_webmercator)/(100*100)) AS value, area_ha
            {{additionalSelect}}
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        WHERE i.date >= '{{begin}}'::date
            AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const ID1 = `with p as (
            SELECT 
            st_makevalid(st_simplify(the_geom_webmercator, {{simplify}})) as the_geom_webmercator, 
            area_ha FROM gadm36_adm1 WHERE iso = UPPER('{{iso}}') AND gid_1 = '{{id1}}'
        )
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom_webmercator, p.the_geom_webmercator))/(10000)) AS value, area_ha
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const ID2 = `with p as (
            SELECT st_makevalid(st_simplify(the_geom_webmercator, {{simplify}})) as the_geom_webmercator, 
            area_ha FROM gadm36_adm2 WHERE iso = UPPER('{{iso}}') AND gid_1 = '{{id1}}' AND gid_2 = '{{id2}}'
        )
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom_webmercator, p.the_geom_webmercator))/(10000)) AS value, area_ha
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const USEAREA = `select area_ha FROM {{useTable}} WHERE cartodb_id = {{pid}}`;

const USE = `SELECT area_ha, data_type, SUM(ST_Area(ST_Intersection(
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
        GROUP BY data_type, area_ha`;

const WDPAAREA = `select gis_area*100 as area_ha FROM wdpa_protected_areas WHERE wdpaid = {{wdpaid}}`;

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
                            p.the_geom_webmercator))/(10000)) AS value, area_ha
            {{additionalSelect}}
            FROM p
            inner join imazon_sad i
            on st_intersects(i.the_geom_webmercator,
                            p.the_geom_webmercator)
            and i.date >= '{{begin}}'::date
                        AND i.date <= '{{end}}'::date
            GROUP BY data_type, area_ha`;

const LATEST = `SELECT MAX(date) AS latest
    FROM imazon_sad`;

const MIN_MAX_DATE_SQL = ', MIN(date) as min_date, MAX(date) as max_date ';

const GIDAREA = `select area_ha FROM {{table}} WHERE gid_{{level}} = '{{gid}}'`;

const executeThunk = (client, sql, params) => (callback) => {
    logger.info(Mustache.render(sql, params));
    client.execute(sql, params).done((data) => {
        callback(null, data);
    }).error((err) => {
        callback(err, null);
    });
};

const routeToGid = (adm0, adm1, adm2) => ({
    adm0,
    adm1: adm1 ? `${adm0}.${adm1}_1` : null,
    adm2: adm2 ? `${adm0}.${adm1}.${adm2}_1` : null
});

const getToday = () => {
    const today = new Date();
    return `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}-${today.getDate().toString()}`;
};

const defaultDate = () => {
    const to = getToday();
    const from = '2008-04-30';
    return `${from},${to}`;
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

    // eslint-disable-next-line consistent-return
    getDownloadUrls(query, params) {
        try {
            const formats = ['csv', 'json', 'kml', 'shp', 'svg'];
            const download = {};
            let queryFinal = Mustache.render(query, params);
            queryFinal = queryFinal.replace(MIN_MAX_DATE_SQL, '');
            queryFinal = encodeURIComponent(queryFinal);
            for (let i = 0, { length } = formats; i < length; i++) {
                download[formats[i]] = `${this.apiUrl}?q=${queryFinal}&format=${formats[i]}`;
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
        const periods = period.split(',');
        const params = {
            iso: gid.adm0,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        if (iso === 'BRA') {
            const data = yield executeThunk(this.client, ISO, params);
            const result = {};
            result.downloadUrls = this.getDownloadUrls(ISO, params);
            result.id = params.iso;
            result.period = period;
            if (data && data.rows && data.rows.length) {
                result.area_ha = data.rows[0].area_ha;
                result.value = data.rows.map((el) => ({
                    label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                    value: el.value,
                    unit: 'ha'
                }));
                return result;
            }
            const area = yield executeThunk(this.client, GIDAREA, {
                table: 'gadm36_countries',
                level: '0',
                gid: params.id0
            });
            if (area && area.rows && area.rows.length) {
                const areaHa = area.rows && area.rows[0] || null;
                result.area_ha = areaHa.area_ha;
                result.value = [];
                return result;
            }
        }
        return null;
    }

    * getAdm1(iso, id1, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining subnational of iso %s and id1', iso, id1);
        const gid = routeToGid(iso, id1);
        const simplify = getSimplify(iso) / 100;
        const periods = period.split(',');
        const params = {
            iso: gid.adm0,
            id1: gid.adm1,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const data = yield executeThunk(this.client, ID1, params);
        const result = {};
        result.downloadUrls = this.getDownloadUrls(ID1, params);
        result.id = params.iso;
        result.period = period;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            return result;
        }
        const area = yield executeThunk(this.client, GIDAREA, { table: 'gadm36_adm1', level: '1', gid: params.id1 });
        if (area && area.rows && area.rows.length) {
            const areaHa = area.rows && area.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.value = [];
            return result;
        }
        return null;
    }

    * getAdm2(iso, id1, id2, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining regional data', iso, id1, id2);
        const gid = routeToGid(iso, id1, id2);
        const simplify = getSimplify(iso) / 100;
        const periods = period.split(',');
        const params = {
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
        const data = yield executeThunk(this.client, ID2, params);
        const result = {};
        result.downloadUrls = this.getDownloadUrls(ID2, params);
        result.id = params.iso;
        result.period = period;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            return result;
        }
        const area = yield executeThunk(this.client, GIDAREA, { table: 'gadm36_adm2', level: '2', gid: params.id2 });
        if (area && area.rows && area.rows.length) {
            const areaHa = area.rows && area.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.value = [];
            return result;
        }
        return null;
    }

    * getUse(useTable, id, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining use with id %s', id);
        const periods = period.split(',');
        const params = {
            useTable,
            pid: id,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }

        const data = yield executeThunk(this.client, USE, params);
        const result = {};
        result.id = id;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            result.period = period;
            result.downloadUrls = this.getDownloadUrls(USE, params);
            return result;
        }

        const areas = yield executeThunk(this.client, USEAREA, params);
        if (areas.rows && areas.rows.length > 0) {
            const areaHa = areas.rows && areas.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.period = period;
            result.value = [];
            return result;
        }
        const geostore = yield GeostoreService.getGeostoreByUse(useTable, id);
        if (geostore) {
            return {
                id,
                value: [],
                area_ha: geostore.area_ha
            };
        }
        return null;
    }

    * getWdpa(wdpaid, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining wpda of id %s', wdpaid);
        const periods = period.split(',');
        const params = {
            wdpaid,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const data = yield executeThunk(this.client, WDPA, params);
        const result = {};
        result.id = wdpaid;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            result.period = period;
            result.downloadUrls = this.getDownloadUrls(WDPA, params);
            return result;
        }
        const areas = yield executeThunk(this.client, WDPAAREA, params);
        if (areas.rows && areas.rows.length > 0) {
            const areaHa = areas.rows && areas.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.period = period;
            result.value = [];
            return result;
        }
        const geostore = yield GeostoreService.getGeostoreByWdpa(wdpaid);
        if (geostore) {
            return {
                id: wdpaid,
                value: [],
                area_ha: geostore.area_ha
            };
        }
        return null;
    }

    * getWorld(hashGeoStore, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining world with hashGeoStore %s', hashGeoStore);

        const geostore = yield GeostoreService.getGeostoreByHash(hashGeoStore);
        if (geostore && geostore.geojson) {
            logger.debug('Executing query in cartodb with geojson', geostore.geojson);
            const periods = period.split(',');
            const params = {
                geojson: JSON.stringify(geostore.geojson.features[0].geometry),
                begin: periods[0],
                end: periods[1]
            };
            if (alertQuery) {
                params.additionalSelect = MIN_MAX_DATE_SQL;
            }
            const data = yield executeThunk(this.client, WORLD, params);
            if (data.rows) {
                const result = {
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
        const periods = period.split(',');
        const params = {
            geojson: JSON.stringify(geojson.features[0].geometry),
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const data = yield executeThunk(this.client, WORLD, params);
        if (data.rows) {
            const result = {
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
        const data = yield executeThunk(this.client, LATEST);
        if (data && data.rows && data.rows.length) {
            const result = data.rows;
            return result;
        }
        return null;
    }

}

module.exports = new CartoDBServiceV2();
