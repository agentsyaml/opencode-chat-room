// Configuration shapes shared by the server, CLI, and center clients.
// This module is type-only so importing it never pulls in file I/O.

export type ChannelDSettings = {
  enabled: boolean;
  config?: string;
  stateFile?: string;
};

export type ServerSettings = {
  host: string;
  port: string;
  token?: string;
  stateDir?: string;
  wakeServeUrl: string;
  maxFileSizeMb?: number;
  channeld: ChannelDSettings;
};

export type ClientSettings = {
  url: string;
  token: string;
  wakeServeUrl: string;
};

// A shared, human-editable configuration file. Environment variables still
// win over the file so a deployment can override one value without editing it.
export type RoomFileConfig = {
  url?: string;
  token?: string;
  server?: {
    host?: string;
    port?: number;
    token?: string;
    stateDir?: string;
    wakeServeUrl?: string;
    maxFileSizeMb?: number;
    channeld?: {
      enabled?: boolean;
      config?: string;
      stateFile?: string;
    };
  };
  client?: {
    url?: string;
    token?: string;
    participant?: string;
    wakeServeUrl?: string;
    delivery?: boolean;
    deliveryIntervalMs?: number;
    requestTimeoutMs?: number;
    codexBin?: string;
  };
  p2p?: {
    enabled?: boolean;
    peers?: Record<string, { url: string; token?: string }>;
  };
};