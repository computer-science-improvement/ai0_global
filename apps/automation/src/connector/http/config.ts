import { connectorStatus, type ConnectorStatus, type ConnectorUrls } from '../types';

export const CONNECTOR_ENV = 'CONNECTOR_ENV';
export const CONNECTOR_CONFIG = 'CONNECTOR_CONFIG';
export const OAUTH_SERVICE = 'CONNECTOR_OAUTH_SERVICE';

export type EnvReader = (k: string) => string | undefined;

/** The connector's settings, read per request (the settings overlay keeps process.env current, so a switch applies at once). */
export interface ConnectorConfig {
  current(): { status: ConnectorStatus; urls: ConnectorUrls | null };
  /** NODE_ENV === 'production' (http://localhost origins and the dev auth bypass are refused there). */
  production(): boolean;
}

export function makeConnectorConfig(env: EnvReader): ConnectorConfig {
  return {
    current: () => connectorStatus(env),
    production: () => env('NODE_ENV') === 'production',
  };
}

/** The URLs when the connector is on and configured, else null (every connector route then answers 404 connector_off). */
export function liveUrls(cfg: ConnectorConfig): ConnectorUrls | null {
  const { status, urls } = cfg.current();
  return status.enabled ? urls : null;
}
