import config from 'config';
import logger from 'logger';
import Mustache from 'mustache';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import CartoDB from 'cartodb';
import GeostoreService from 'services/geostoreService';
import NotFound from 'errors/notFound';

const WORLD: string = `WITH poly AS (SELECT * FROM ST_Transform(ST_SimplifyPreserveTopology(ST_SetSRID(ST_MakeValid(ST_GeomFromGeoJSON('{{{geojson}}}')), 4326), 0.01), 3857) geojson)
             SELECT data_type, count(*) AS value
             FROM imazon_sad i, poly        WHERE i.date >= '{{begin}}'::date
               AND i.date <= '{{end}}'::date  and st_intersects(poly.geojson, i.the_geom_webmercator) group by data_type `;

const ISO: string = `
        with p as (SELECT st_makevalid(st_simplify(the_geom_webmercator, 5)) as the_geom_webmercator, area_ha FROM gadm36_countries WHERE iso = UPPER('{{iso}}'))
        SELECT data_type,
            sum(ST_Area(i.the_geom_webmercator)/(100*100)) AS value, area_ha
            {{additionalSelect}}
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        WHERE i.date >= '{{begin}}'::date
            AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const ID1: string = `with p as (
            SELECT 
            st_makevalid(st_simplify(the_geom_webmercator, {{simplify}})) as the_geom_webmercator, 
            area_ha FROM gadm36_adm1 WHERE iso = UPPER('{{iso}}') AND gid_1 = '{{id1}}'
        )
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom_webmercator, p.the_geom_webmercator))/(10000)) AS value, area_ha
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const ID2: string = `with p as (
            SELECT st_makevalid(st_simplify(the_geom_webmercator, {{simplify}})) as the_geom_webmercator, 
            area_ha FROM gadm36_adm2 WHERE iso = UPPER('{{iso}}') AND gid_1 = '{{id1}}' AND gid_2 = '{{id2}}'
        )
        SELECT data_type, SUM(ST_Area( ST_Intersection( i.the_geom_webmercator, p.the_geom_webmercator))/(10000)) AS value, area_ha
        FROM imazon_sad i right join p on st_intersects(i.the_geom_webmercator, p.the_geom_webmercator)
        and i.date >= '{{begin}}'::date
        AND i.date <= '{{end}}'::date
        GROUP BY data_type, area_ha`;

const USEAREA: string = `select area_ha FROM {{useTable}} WHERE cartodb_id = {{pid}}`;

const USE: string = `SELECT area_ha, data_type, SUM(ST_Area(ST_Intersection(
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

const WDPAAREA: string = `select gis_area*100 as area_ha FROM wdpa_protected_areas WHERE wdpaid = {{wdpaid}}`;

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
                            p.the_geom_webmercator))/(10000)) AS value, area_ha
            {{additionalSelect}}
            FROM p
            inner join imazon_sad i
            on st_intersects(i.the_geom_webmercator,
                            p.the_geom_webmercator)
            and i.date >= '{{begin}}'::date
                        AND i.date <= '{{end}}'::date
            GROUP BY data_type, area_ha`;

const LATEST: string = `SELECT MAX(date) AS latest
    FROM imazon_sad`;

const MIN_MAX_DATE_SQL: string = ', MIN(date) as min_date, MAX(date) as max_date ';

const GIDAREA: string = `select area_ha FROM {{table}} WHERE gid_{{level}} = '{{gid}}'`;

const executeThunk = async (client: CartoDB.SQL, sql: string, params: any): Promise<Record<string, any>> => (new Promise((resolve: (value: (PromiseLike<unknown> | unknown)) => void, reject: (reason?: any) => void) => {
    logger.debug(Mustache.render(sql, params));
    client.execute(sql, params).done((data: Record<string, any>) => {
        resolve(data);
    }).error((error: Error) => {
        reject(error);
    });
}));

const routeToGid = (adm0: string, adm1?: string, adm2?: string): Record<string, any> => ({
    adm0,
    adm1: adm1 ? `${adm0}.${adm1}_1` : null,
    adm2: adm2 ? `${adm0}.${adm1}.${adm2}_1` : null
});

const getToday = (): string => {
    const today: Date = new Date();
    return `${today.getFullYear().toString()}-${(today.getMonth() + 1).toString()}-${today.getDate().toString()}`;
};

const defaultDate = (): string => {
    const to: string = getToday();
    const from: string = '2011-09-01';
    return `${from},${to}`;
};

const getSimplify = (iso: string): number => {
    let thresh: number = 0.005;
    if (iso) {
        const bigCountries: string[] = ['USA', 'RUS', 'CAN', 'CHN', 'BRA', 'IDN'];
        thresh = bigCountries.includes(iso) ? 0.05 : 0.005;
    }
    return thresh;
};

class CartoDBServiceV2 {

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
            const formats: string[] = ['csv', 'json', 'kml', 'shp', 'svg'];
            const download: Record<string, any> = {};
            let queryFinal: string = Mustache.render(query, params);
            queryFinal = queryFinal.replace(MIN_MAX_DATE_SQL, '');
            queryFinal = encodeURIComponent(queryFinal);
            for (let i: number = 0, { length } = formats; i < length; i++) {
                download[formats[i]] = `${this.apiUrl}?q=${queryFinal}&format=${formats[i]}`;
            }
            return download;
        } catch (err) {
            logger.error(err);
        }
    }


    async getAdm0(iso: string, alertQuery: string, period: string = defaultDate()): Promise<Record<string, any>> {
        logger.debug('Obtaining national of iso %s', iso);
        const gid: Record<string, any> = routeToGid(iso);
        const simplify: number = getSimplify(iso);
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            iso: gid.adm0,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        if (iso === 'BRA') {
            const data: Record<string, any> = await executeThunk(this.client, ISO, params);
            const result: Record<string, any> = {};
            result.downloadUrls = this.getDownloadUrls(ISO, params);
            result.id = params.iso;
            result.period = period;
            if (data && data.rows && data.rows.length) {
                result.area_ha = data.rows[0].area_ha;
                result.value = data.rows.map((el: Record<string, any>) => ({
                    label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                    value: el.value,
                    unit: 'ha'
                }));
                return result;
            }
            const area: Record<string, any> = await executeThunk(this.client, GIDAREA, {
                table: 'gadm36_countries',
                level: '0',
                gid: params.id0
            });
            if (area && area.rows && area.rows.length) {
                const areaHa: any = area.rows && area.rows[0] || null;
                result.area_ha = areaHa.area_ha;
                result.value = [];
                return result;
            }
        }
        return null;
    }

    async getAdm1(iso: string, id1: string, alertQuery: string, period: string = defaultDate()): Promise<Record<string, any>> {
        logger.debug('Obtaining subnational of iso %s and id1', iso, id1);
        const gid: Record<string, any> = routeToGid(iso, id1);
        const simplify: number = getSimplify(iso) / 100;
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
            iso: gid.adm0,
            id1: gid.adm1,
            begin: periods[0],
            end: periods[1],
            simplify
        };
        if (alertQuery) {
            params.additionalSelect = MIN_MAX_DATE_SQL;
        }
        const data: Record<string, any> = await executeThunk(this.client, ID1, params);
        const result: Record<string, any> = {};
        result.downloadUrls = this.getDownloadUrls(ID1, params);
        result.id = params.iso;
        result.period = period;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el: Record<string, any>) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            return result;
        }
        const area: Record<string, any> = await executeThunk(this.client, GIDAREA, {
            table: 'gadm36_adm1',
            level: '1',
            gid: params.id1
        });
        if (area && area.rows && area.rows.length) {
            const areaHa: any = area.rows && area.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.value = [];
            return result;
        }
        return null;
    }

    async getAdm2(iso: string, id1: string, id2: string, alertQuery: string, period: string = defaultDate()): Promise<Record<string, any>> {
        logger.debug('Obtaining regional data', iso, id1, id2);
        const gid: Record<string, any> = routeToGid(iso, id1, id2);
        const simplify: number = getSimplify(iso) / 100;
        const periods: string[] = period.split(',');
        const params: Record<string, any> = {
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
        const data: Record<string, any> = await executeThunk(this.client, ID2, params);
        const result: Record<string, any> = {};
        result.downloadUrls = this.getDownloadUrls(ID2, params);
        result.id = params.iso;
        result.period = period;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el: Record<string, any>) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            return result;
        }
        const area: Record<string, any> = await executeThunk(this.client, GIDAREA, {
            table: 'gadm36_adm2',
            level: '2',
            gid: params.id2
        });
        if (area && area.rows && area.rows.length) {
            const areaHa: any = area.rows && area.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.value = [];
            return result;
        }
        return null;
    }

    async getUse(useTable: string, id: string, alertQuery: string, period: string = defaultDate(), apiKey: string): Promise<Record<string, any>> {
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

        const data: Record<string, any> = await executeThunk(this.client, USE, params);
        const result: Record<string, any> = {};
        result.id = id;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el: Record<string, any>) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            result.period = period;
            result.downloadUrls = this.getDownloadUrls(USE, params);
            return result;
        }

        const areas: Record<string, any> = await executeThunk(this.client, USEAREA, params);
        if (areas.rows && areas.rows.length > 0) {
            const areaHa: any = areas.rows && areas.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.period = period;
            result.value = [];
            return result;
        }
        const geostore: Record<string, any> = await GeostoreService.getGeostoreByUse(useTable, id, apiKey);
        if (geostore) {
            return {
                id,
                value: [],
                area_ha: geostore.area_ha
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
        const data: Record<string, any> = await executeThunk(this.client, WDPA, params);
        const result: Record<string, any> = {};
        result.id = wdpaid;
        if (data && data.rows && data.rows.length) {
            result.area_ha = data.rows[0].area_ha;
            result.value = data.rows.map((el: Record<string, any>) => ({
                label: el.data_type === 'defor' ? 'deforestation' : 'degraded',
                value: el.value,
                unit: 'ha'
            }));
            result.period = period;
            result.downloadUrls = this.getDownloadUrls(WDPA, params);
            return result;
        }
        const areas: Record<string, any> = await executeThunk(this.client, WDPAAREA, params);
        if (areas.rows && areas.rows.length > 0) {
            const areaHa: any = areas.rows && areas.rows[0] || null;
            result.area_ha = areaHa.area_ha;
            result.period = period;
            result.value = [];
            return result;
        }
        const geostore: Record<string, any> = await GeostoreService.getGeostoreByWdpa(wdpaid, apiKey);
        if (geostore) {
            return {
                id: wdpaid,
                value: [],
                area_ha: geostore.area_ha
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

    async latest(): Promise<Array<Record<string, any>>> {
        logger.debug('Obtaining latest date');
        const data: Record<string, any> = await executeThunk(this.client, LATEST, {});
        if (data && data.rows && data.rows.length) {
            const result: Array<Record<string, any>> = data.rows;
            return result;
        }
        return null;
    }

}

export default new CartoDBServiceV2();
