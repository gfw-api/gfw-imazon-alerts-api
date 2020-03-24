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
        with p as (SELECT the_geom_webmercator FROM gadm2_countries_simple WHERE iso = UPPER('{{iso}}'))
        SELECT data_type,
            sum(ST_Area(i.the_geom_webmercator)/(100*100)) AS value
            {{additionalSelect}}
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        WHERE i.date >= '{{begin}}'::date
            AND i.date <= '{{end}}'::date
        GROUP BY data_type `;

const ID1 = `with p as (SELECT the_geom_webmercator FROM gadm2_provinces_simple WHERE iso = UPPER('{{iso}}') AND id_1 = {{id1}})
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom_webmercator, p.the_geom_webmercator))/(10000)) AS value
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type`;

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

const LATEST = `SELECT DISTINCT date
        FROM imazon_sad
        WHERE date IS NOT NULL
        ORDER BY date DESC
        LIMIT {{limit}}`;

const MIN_MAX_DATE_SQL = ', MIN(date) as min_date, MAX(date) as max_date ';

const executeThunk = (client, sql, params) => (callback) => {
    logger.info(Mustache.render(sql, params));
    client.execute(sql, params).done((data) => {
        callback(null, data);
    }).error((err) => {
        callback(err, null);
    });
};

const getToday = () => {
    const today = new Date();
    return `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}-${today.getDate().toString()}`;
};

const getYesterday = () => {
    const yesterday = new Date(Date.now() - (24 * 60 * 60 * 1000));
    return `${yesterday.getFullYear().toString()}-${(yesterday.getMonth() + 1).toString()}-${yesterday.getDate().toString()}`;
};


const defaultDate = () => {
    const to = getToday();
    const from = getYesterday();
    return `${from},${to}`;
};

class CartoDBService {

    constructor() {
        this.client = new CartoDB.SQL({
            user: config.get('cartoDB.user')
        });
        this.apiUrl = config.get('cartoDB.apiUrl');
    }

    // eslint-disable-next-line consistent-return
    getDownloadUrls(query, params) {
        try {
            const formats = ['csv', 'geojson', 'kml', 'shp', 'svg'];
            const download = {};
            let queryFinal = Mustache.render(query, params);
            queryFinal = queryFinal.replace(MIN_MAX_DATE_SQL, '');
            queryFinal = queryFinal.replace('SELECT data_type,', 'SELECT i.data_type, i.the_geom,');
            queryFinal = queryFinal.replace('GROUP BY data_type', 'GROUP BY data_type, i.the_geom');
            queryFinal = encodeURIComponent(queryFinal);
            for (let i = 0, { length } = formats; i < length; i++) {
                download[formats[i]] = `${this.apiUrl}?q=${queryFinal}&format=${formats[i]}`;
            }
            return download;
        } catch (err) {
            logger.error(err);
        }
    }


    * getNational(iso, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining national of iso %s', iso);
        const periods = period.split(',');
        const params = {
            iso,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const geostore = yield GeostoreService.getGeostoreByIso(iso);
        if (geostore) {
            if (iso === 'BRA') {
                const data = yield executeThunk(this.client, ISO, params);
                if (data.rows) {
                    const result = {
                        value: data.rows
                    };
                    result.area_ha = geostore.areaHa;
                    result.downloadUrls = this.getDownloadUrls(ISO, params);
                    return result;
                }
                return {
                    area_ha: geostore.areaHa
                };

            }
            return {
                value: [],
                area_ha: geostore.areaHa
            };

        }
        return null;
    }

    * getSubnational(iso, id1, alertQuery, period = defaultDate()) {
        logger.debug('Obtaining subnational of iso %s and id1', iso, id1);
        const periods = period.split(',');
        const params = {
            iso,
            id1,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }

        const geostore = yield GeostoreService.getGeostoreByIsoAndId(iso, id1);
        if (geostore) {
            if (iso === 'BRA') {
                const data = yield executeThunk(this.client, ID1, params);
                if (data.rows) {
                    const result = {
                        value: data.rows
                    };
                    result.area_ha = geostore.areaHa;
                    result.downloadUrls = this.getDownloadUrls(ID1, params);
                    return result;
                }
                return {
                    value: [],
                    area_ha: geostore.areaHa
                };

            }
            return {
                value: [],
                area_ha: geostore.areaHa
            };

        }
        return null;
    }

    * getUse(useName, useTable, id, alertQuery, period = defaultDate()) {
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

        const geostore = yield GeostoreService.getGeostoreByUse(useName, id);
        const data = yield executeThunk(this.client, USE, params);
        if (geostore) {
            if (data.rows && data.rows.length > 0 && data.rows[0].data_type !== null) {
                const result = {
                    value: data.rows
                };
                result.area_ha = geostore.areaHa;
                result.downloadUrls = this.getDownloadUrls(USE, params);
                return result;
            }
            return {
                value: [],
                area_ha: geostore.areaHa
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
        const geostore = yield GeostoreService.getGeostoreByWdpa(wdpaid);
        const data = yield executeThunk(this.client, WDPA, params);
        if (geostore) {
            if (data.rows) {
                const result = {
                    value: data.rows
                };
                result.area_ha = geostore.areaHa;
                result.downloadUrls = this.getDownloadUrls(WDPA, params);
                return result;
            }
            return {
                value: [],
                area_ha: geostore.areaHa
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

    * latest(limit = 3) {
        logger.debug('Obtaining latest with limit %s', limit);
        const params = {
            limit
        };
        const data = yield executeThunk(this.client, LATEST, params);
        logger.debug('data', data);
        if (data.rows) {
            const result = data.rows;
            return result;
        }
        return null;
    }

}

module.exports = new CartoDBService();
