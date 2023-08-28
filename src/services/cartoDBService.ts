import config from 'config';
import logger from 'logger';
import Mustache from 'mustache';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import CartoDB from 'cartodb';
import GeostoreService from 'services/geostoreService';
import NotFound from "errors/notFound";

const WORLD: string = `WITH poly AS (SELECT * FROM ST_Transform(ST_SimplifyPreserveTopology(ST_SetSRID(ST_MakeValid(ST_GeomFromGeoJSON('{{{geojson}}}')), 4326), 0.01), 3857) geojson)
             SELECT data_type, count(*) AS value
             FROM imazon_sad i, poly        WHERE i.date >= '{{begin}}'::date
               AND i.date <= '{{end}}'::date  and st_intersects(poly.geojson, i.the_geom_webmercator) group by data_type `;

const ISO: string = `
        with p as (SELECT the_geom_webmercator FROM gadm2_countries_simple WHERE iso = UPPER('{{iso}}'))
        SELECT data_type,
            sum(ST_Area(i.the_geom_webmercator)/(100*100)) AS value
            {{additionalSelect}}
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        WHERE i.date >= '{{begin}}'::date
            AND i.date <= '{{end}}'::date
        GROUP BY data_type `;

const ID1: string = `with p as (SELECT the_geom_webmercator FROM gadm2_provinces_simple WHERE iso = UPPER('{{iso}}') AND id_1 = {{id1}})
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom_webmercator, p.the_geom_webmercator))/(10000)) AS value
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type`;

const USE: string = `SELECT data_type, SUM(ST_Area(ST_Intersection(
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

const WDPA: string = `WITH  p as ( SELECT
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

const LATEST: string = `SELECT DISTINCT date
        FROM imazon_sad
        WHERE date IS NOT NULL
        ORDER BY date DESC
        LIMIT {{limit}}`;

const MIN_MAX_DATE_SQL: string = ', MIN(date) as min_date, MAX(date) as max_date ';

const executeThunk = async (client: CartoDB.SQL, sql: string, params: any): Promise<Record<string, any>> => (new Promise((resolve: (value: (PromiseLike<unknown> | unknown)) => void, reject: (reason?: any) => void) => {
    logger.debug(Mustache.render(sql, params));
    client.execute(sql, params).done((data: Record<string, any>) => {
        resolve(data);
    }).error((error: Error) => {
        reject(error);
    });
}));

const getToday = (): string => {
    const today: Date = new Date();
    return `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}-${today.getDate().toString()}`;
};

const getYesterday = (): string => {
    const yesterday: Date = new Date(Date.now() - (24 * 60 * 60 * 1000));
    return `${yesterday.getFullYear().toString()}-${(yesterday.getMonth() + 1).toString()}-${yesterday.getDate().toString()}`;
};


const defaultDate = (): string => {
    const to: string = getToday();
    const from: string = getYesterday();
    return `${from},${to}`;
};

class CartoDBService {

    client: CartoDB.SQL;
    apiUrl: string;

    constructor() {
        this.client = new CartoDB.SQL({
            user: config.get('cartoDB.user')
        });
        this.apiUrl = config.get('cartoDB.apiUrl');
    }

    getDownloadUrls(query: string, params: Record<string, any>): Record<string, any> | void {
        try {
            const formats: string[] = ['csv', 'geojson', 'kml', 'shp', 'svg'];
            const download: Record<string, any> = {};
            let queryFinal: string = Mustache.render(query, params);
            queryFinal = queryFinal.replace(MIN_MAX_DATE_SQL, '');
            queryFinal = queryFinal.replace('SELECT data_type,', 'SELECT i.data_type, i.the_geom,');
            queryFinal = queryFinal.replace('GROUP BY data_type', 'GROUP BY data_type, i.the_geom');
            queryFinal = encodeURIComponent(queryFinal);
            for (let i: number = 0, { length } = formats; i < length; i++) {
                download[formats[i]] = `${this.apiUrl}?q=${queryFinal}&format=${formats[i]}`;
            }
            return download;
        } catch (err) {
            logger.error(err);
        }
    }

    async getNational(iso: string, alertQuery: string, period: string = defaultDate(), apiKey: string): Promise<Record<string, any>> {
        logger.debug('Obtaining national of iso %s', iso);
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            iso,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const geostore: Record<string, any> = await GeostoreService.getGeostoreByIso(iso, apiKey);
        if (geostore) {
            if (iso === 'BRA') {
                const data: Record<string, any> = await executeThunk(this.client, ISO, params);
                if (data.rows) {
                    const result: Record<string, any> = {
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

    async getSubnational(iso: string, id1: string, alertQuery: string, period: string = defaultDate(), apiKey: string): Promise<Record<string, any>> {
        logger.debug('Obtaining subnational of iso %s and id1', iso, id1);
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            iso,
            id1,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }

        const geostore: Record<string, any> = await GeostoreService.getGeostoreByIsoAndId(iso, id1, apiKey);
        if (geostore) {
            if (iso === 'BRA') {
                const data: Record<string, any> = await executeThunk(this.client, ID1, params);
                if (data.rows) {
                    const result: Record<string, any> = {
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

    async getUse(useName: string, useTable: string, id: string, alertQuery: string, period: string = defaultDate(), apiKey: string): Promise<Record<string, any>> {
        logger.debug('Obtaining use with id %s', id);
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            useTable,
            pid: id,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }

        const geostore: Record<string, any> = await GeostoreService.getGeostoreByUse(useName, id, apiKey);
        const data: Record<string, any> = await executeThunk(this.client, USE, params);
        if (geostore) {
            if (data.rows && data.rows.length > 0 && data.rows[0].data_type !== null) {
                const result: Record<string, any> = {
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

    async getWdpa(wdpaid: string, alertQuery: string, period: string = defaultDate(), apiKey: string): Promise<Record<string, any>> {
        logger.debug('Obtaining wpda of id %s', wdpaid);
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            wdpaid,
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const geostore: Record<string, any> = await GeostoreService.getGeostoreByWdpa(wdpaid, apiKey);
        const data: Record<string, any> = await executeThunk(this.client, WDPA, params);
        if (geostore) {
            if (data.rows) {
                const result: Record<string, any> = {
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

    async getWorld(hashGeoStore: string, alertQuery: string, period: string = defaultDate(), apiKey: string): Promise<Record<string, any>> {
        logger.debug('Obtaining world with hashGeoStore %s', hashGeoStore);

        const geostore: Record<string, any> = await GeostoreService.getGeostoreByHash(hashGeoStore, apiKey);
        if (geostore && geostore.geojson) {
            logger.debug('Executing query in cartodb with geojson', geostore.geojson);
            const periods: string[] = period.split(',');
            const params: Record<string, any> = {
                geojson: JSON.stringify(geostore.geojson.features[0].geometry),
                begin: periods[0],
                end: periods[1]
            };
            if (alertQuery) {
                params.additionalSelect = MIN_MAX_DATE_SQL;
            }
            const data: Record<string, any> = await executeThunk(this.client, WORLD, params);
            if (data.rows) {
                const result: Record<string, any> = {
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

    async getWorldWithGeojson(geojson: Record<string, any>, alertQuery: string, period: string = defaultDate()): Promise<Record<string, any>> {
        logger.debug('Executing query in cartodb with geojson', geojson);
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            geojson: JSON.stringify(geojson.features[0].geometry),
            begin: periods[0],
            end: periods[1]
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const data: Record<string, any> = await executeThunk(this.client, WORLD, params);
        if (data.rows) {
            const result: Record<string, any> = {
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

    async latest(limit: string = "3"): Promise<Array<any> | void> {
        logger.debug('Obtaining latest with limit %s', limit);
        const parsedLimit: number = parseInt(limit, 10);
        const params: { limit: number } = {
            limit: parsedLimit
        };
        const data: Record<string, any> = await executeThunk(this.client, LATEST, params);
        logger.debug('data', data);
        if (data.rows) {
            return data.rows;
        }
        return null;
    }

}

export default new CartoDBService();
