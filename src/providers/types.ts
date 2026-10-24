export interface ProviderServer {
  id: string;
  name: string;
  status: string;
  ipv4: string | null;
  ipv6: string | null;
  arch?: "arm64" | "x86_64";
  size?: string;
  location?: string;
}

export interface Capabilities {
  create: boolean;
  destroy: boolean;
  reinstall: boolean;
  snapshot: boolean;
  rdns: boolean;
  catalog: boolean;
}

export interface CreateSpec {
  name: string;
  size: string;
  location: string;
  /** Public SSH keys that get root access. */
  sshKeys: string[];
  /** Ubuntu LTS version, e.g. "24.04". */
  ubuntu: string;
}

export interface CatalogEntry {
  size: string;
  arch: "arm64" | "x86_64";
  cpus: number;
  memory_gb: number;
  disk_gb: number;
  monthly: number | null;
  currency: string;
  locations: string[];
}

export interface Provider {
  readonly type: string;
  readonly capabilities: Capabilities;
  /** Where to do by hand what the API cannot. */
  readonly panel: string;
  get(id: string): Promise<ProviderServer>;
  list(): Promise<ProviderServer[]>;
  create?(spec: CreateSpec): Promise<ProviderServer>;
  /** The server's name at the provider (`fornax server rename`). */
  rename?(id: string, name: string): Promise<void>;
  /** Protection against deleting (and rebuilding) the server, at the provider. */
  protect?(id: string, on: boolean): Promise<void>;
  destroy?(id: string): Promise<void>;
  reinstall?(id: string): Promise<void>;
  snapshot?(id: string, description: string): Promise<string>;
  rdns?(id: string, ip: string, ptr: string): Promise<void>;
  catalog?(): Promise<CatalogEntry[]>;
}

export const NONE: Capabilities = { create: false, destroy: false, reinstall: false, snapshot: false, rdns: false, catalog: false };
