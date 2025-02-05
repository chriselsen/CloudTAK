import Err from '@openaddresses/batch-error';
import { randomPoint } from '@turf/random';
import ImportControl, { ImportModeEnum }  from './control/import.js';
import Sinks from './sinks.js';
import Config from './config.js';
import Metrics from './aws/metric.js';
import { randomUUID } from 'node:crypto';
import TAK, { CoT } from '@tak-ps/node-tak';
import Modeler from '@openaddresses/batch-generic';
import { Connection } from './schema.js';
import { InferSelectModel } from 'drizzle-orm';
import sleep from './sleep.js';
import TAKAPI, { APIAuthCertificate, } from '../lib/tak-api.js';
import type ConnectionConfig from './connection-config.js';
import { MachineConnConfig } from './connection-config.js';

export class ConnectionClient {
    config: ConnectionConfig;
    tak: TAK;
    retry: number;
    initial: boolean;
    ephemeral: boolean;

    constructor(
        config: ConnectionConfig,
        tak: TAK,
        ephemeral = false
    ) {
        this.tak = tak;
        this.config = config;
        this.retry = 0;
        this.initial = true;
        this.ephemeral = ephemeral;
    }
}

/**
 * Maintain a pool of TAK Connections, reconnecting as necessary
 * @class
 */
export default class ConnectionPool extends Map<number | string, ConnectionClient> {
    config: Config;
    metrics: Metrics;
    sinks: Sinks;
    importControl: ImportControl;

    constructor(config: Config) {
        super();

        this.config = config;
        this.importControl = new ImportControl(config);
        this.metrics = new Metrics(this.config.StackName);

        if (config.nometrics) this.metrics.paused = true;
        this.sinks = new Sinks(config);
    }

    async subscription(connection: number | string, name: string): Promise<{
        name: string;
        token?: string;
    }> {
        const conn = this.get(connection);
        if (!conn) return { name: name };
        const sub = await conn.config.subscription(name);
        if (!sub) return { name: name };
        return {
            name: sub.name,
            token: sub.token || undefined
        };
    }

    async refresh() {
        for (const conn of this.keys()) {
            this.delete(conn);
        }

        await this.init();
    }

    /**
     * Page through connections and start a connection for each one
     */
    async init(): Promise<void> {
        const conns: Promise<ConnectionClient>[] = [];

        const ConnectionModel = new Modeler(this.config.pg, Connection);
        const stream = ConnectionModel.stream();

        return new Promise((resolve, reject) => {
            stream.on('data', async (conn: InferSelectModel<typeof Connection>) => {
                if (conn.enabled) {
                    conns.push(this.add(new MachineConnConfig(this.config, conn)));
                }
            }).on('error', (err) => {
                return reject(err);
            }).on('end', async () => {
                try {
                    await Promise.all(conns);
                    return resolve();
                } catch (err) {
                    console.error(err);
                    return reject(err);
                }

            });
        });
    }

    status(id: number | string): string {
        const conn = this.get(id);

        if (conn) {
            return conn.tak.open ? 'live' : 'dead';
        } else {
            return 'unknown';
        }
    }

    /**
     * Handle writing a CoT into the Sink/WebSocket Clients
     * This is also called externally by the layer/:layer/cot API as CoTs
     * aren't rebroadcast to the submitter by the TAK Server
     */
    async cots(conn: ConnectionConfig, cots: CoT[], ephemeral=false) {
        try {
            if (this.config.wsClients.has(String(conn.id))) {
                for (const cot of cots) {
                    const feat = cot.to_geojson();

                    try {
                        if (ephemeral && feat.properties && feat.properties.chat) {
                            await this.config.models.ProfileChat.generate({
                                username: String(conn.id),
                                chatroom: feat.properties.chat.senderCallsign,
                                sender_callsign: feat.properties.chat.senderCallsign,
                                sender_uid: feat.properties.chat.chatgrp._attributes.uid0,
                                message_id: feat.properties.chat.messageId || randomUUID(),
                                message: feat.properties.remarks || ''
                            });
                        } else if (ephemeral && feat.properties.fileshare) {
                            const file = new URL(feat.properties.fileshare.senderUrl);

                            await this.importControl.create({
                                username: String(conn.id),
                                name: feat.properties.fileshare.name,
                                mode: ImportModeEnum.PACKAGE,
                                mode_id: file.searchParams.get('hash') || undefined
                            })
                        }
                    } catch (err) {
                        console.error('Failed to save COT: ', err);
                    }

                    for (const client of (this.config.wsClients.get(String(conn.id)) || [])) {
                        if (client.format == 'geojson') {
                            if (feat.properties && feat.properties.chat) {
                                client.ws.send(JSON.stringify({ type: 'chat', connection: conn.id, data: feat }));
                            } else if (feat.properties.type.startsWith("t-x")) {
                                client.ws.send(JSON.stringify({ type: 'task', connection: conn.id, data: feat }));
                            } else {
                console.error('Submitting Point', feat.geometry.coordinates);
                                client.ws.send(JSON.stringify({ type: 'cot', connection: conn.id, data: feat }));
                            }
                        } else {
                            client.ws.send(JSON.stringify({ type: 'cot', connection: conn.id, data: cot.raw }));
                        }
                    }
                }
            }

            if (!ephemeral && !this.config.nosinks) {
                await this.sinks.cots(conn, cots.filter((cot) => {
                    return cot.is_atom();
                }));
            }
        } catch (err) {
            console.error('Error', err);
        }
    }

    async add(connConfig: ConnectionConfig, ephemeral=false): Promise<ConnectionClient> {
        if (!connConfig.auth || !connConfig.auth.cert || !connConfig.auth.key) throw new Err(400, null, 'Connection must have auth.cert & auth.key');
        const tak = await TAK.connect(connConfig.id, new URL(this.config.server.url), connConfig.auth);
        const connClient = new ConnectionClient(connConfig, tak, ephemeral);

        const api = await TAKAPI.init(new URL(String(this.config.server.api)), new APIAuthCertificate(connConfig.auth.cert, connConfig.auth.key));
        this.set(connConfig.id, connClient);

        tak.on('cot', async (cot: CoT) => {
            connClient.retry = 0;
            connClient.initial = false;

            this.cots(connConfig, [cot], ephemeral);
        }).on('secureConnect', async () => {
            for (const sub of await connConfig.subscriptions()) {
                let retry = true;
                do {
                    try {
                        await api.Mission.subscribe(sub.name, {
                            uid: connConfig.uid()
                        },{
                            token: sub.token || undefined
                        });

                        console.log(`Connection: ${connConfig.id} - Sync: ${sub.name}: Subscribed!`);
                        retry = false;
                    } catch (err) {
                        console.warn(`Connection: ${connConfig.id} (${connConfig.uid()}) - Sync: ${sub.name}: ${err instanceof Error ? err.message : String(err)}`);

                        if (err instanceof Error && err.message.includes('ECONNREFUSED')) {
                            await sleep(1000);
                        } else {
                            // We don't retry for unknown issues as it could be the Sync has been remotely deleted and will
                            // retry forwever
                            retry = false;
                        }
                    }
                } while (retry)
            }

        if (connConfig.id === 'nicholas.ingalls@state.co.us') {
            const pts = randomPoint(100000);

            for (const pt of pts.features) {
                this.cots(connConfig, [ CoT.from_geojson(pt) ], ephemeral);
            }
        }


        }).on('end', async () => {
            console.error(`not ok - ${connConfig.id} - ${connConfig.name} @ end`);
            this.retry(connClient);
        }).on('timeout', async () => {
            console.error(`not ok - ${connConfig.id} - ${connConfig.name} @ timeout`);
            this.retry(connClient);
        }).on('ping', async () => {
            if (this.config.StackName !== 'test' && !ephemeral && typeof connConfig.id === 'number') {
                try {
                    await this.metrics.post(connConfig.id);
                } catch (err) {
                    console.error(`not ok - failed to push metrics - ${err}`);
                }
            }
        }).on('error', async (err) => {
            console.error(`not ok - ${connConfig.id} - ${connConfig.name} @ error:${err}`);
            this.retry(connClient);
        });

        return connClient;
    }

    async retry(connClient: ConnectionClient) {
        const retryms = Math.min(connClient.retry * 1000, 15000);
        if (connClient.retry <= 15) connClient.retry++
        console.log(`not ok - ${connClient.config.uid()} - ${connClient.config.name} - retrying in ${retryms}ms`)
        await sleep(retryms);
        await connClient.tak.reconnect();
    }

    delete(id: number | string): boolean {
        const conn = this.get(id);

        if (conn) {
            conn.tak.destroy();
            super.delete(id);

            return true;
        } else {
            return false;
        }
    }
}
