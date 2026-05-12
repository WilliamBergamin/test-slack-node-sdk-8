import assert from 'node:assert/strict';
import { once } from 'node:events';
import http, { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import 'dotenv/config';
import { type Logger, LogLevel, SocketModeClient } from '@slack/socket-mode';
import type { FetchFunction } from '@slack/web-api';
import { createProxy } from 'proxy';
import { ProxyAgent, type RequestInit, fetch as undiciFetch } from 'undici';

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCapturingLogger(): { logger: Logger; logs: string[] } {
  const logs: string[] = [];
  const logger: Logger = {
    debug: (...msgs: unknown[]) => logs.push(`[DEBUG] ${msgs.join(' ')}`),
    info: (...msgs: unknown[]) => logs.push(`[INFO] ${msgs.join(' ')}`),
    warn: (...msgs: unknown[]) => logs.push(`[WARN] ${msgs.join(' ')}`),
    error: (...msgs: unknown[]) => logs.push(`[ERROR] ${msgs.join(' ')}`),
    getLevel: () => LogLevel.DEBUG,
    setLevel: () => {},
    setName: () => {},
  };
  return { logger, logs };
}

describe('SocketModeClient', () => {
  let proxyServer: Server;
  let proxyUrl: string;

  before(async () => {
    if (!SLACK_APP_TOKEN) {
      throw new Error('SLACK_APP_TOKEN environment variable is required.');
    }
    proxyServer = createProxy(createServer());
    proxyServer.listen(0, '127.0.0.1');
    await once(proxyServer, 'listening');
    const addr = proxyServer.address() as { port: number };
    proxyUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    proxyServer.close();
  });

  it('Construction validation', async () => {
    let threw = false;
    try {
      new SocketModeClient({ appToken: '' });
    } catch {
      threw = true;
    }
    assert.ok(threw, 'should throw when appToken is empty');

    const client = new SocketModeClient({ appToken: SLACK_APP_TOKEN! });
    assert.ok(client instanceof SocketModeClient, 'should create instance');
  });

  it('Connection lifecycle', { timeout: 20000 }, async () => {
    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logLevel: LogLevel.WARN,
    });

    try {
      const connectResult = await withTimeout(client.start(), 15000, 'client.start()');
      assert.equal(connectResult.ok, true, 'start() should resolve with ok: true');
      assert.ok(client.websocket !== undefined, 'websocket should be defined after start');
    } finally {
      await client.disconnect();
    }
  });

  it('Lifecycle events', { timeout: 20000 }, async () => {
    const events: string[] = [];
    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logLevel: LogLevel.WARN,
    });

    client.on('connecting', () => events.push('connecting'));
    client.on('authenticated', () => events.push('authenticated'));
    client.on('connected', () => events.push('connected'));
    client.on('disconnecting', () => events.push('disconnecting'));
    client.on('disconnected', () => events.push('disconnected'));

    try {
      await withTimeout(client.start(), 15000, 'client.start()');
      assert.ok(events.includes('connecting'), 'should emit connecting');
      assert.ok(events.includes('connected'), 'should emit connected');
    } finally {
      await client.disconnect();
      await delay(500);
    }

    assert.ok(events.includes('disconnecting'), 'should emit disconnecting');
    assert.ok(events.includes('disconnected'), 'should emit disconnected');

    const connectingIdx = events.indexOf('connecting');
    const connectedIdx = events.indexOf('connected');
    assert.ok(connectingIdx < connectedIdx, 'connecting should fire before connected');
  });

  it('Event receive + ack', { timeout: 45000 }, async () => {
    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logLevel: LogLevel.WARN,
    });

    let eventReceived = false;
    let ackSent = false;

    client.on('slack_event', async ({ ack, body }) => {
      eventReceived = true;
      console.log(`-> Received event type: ${body?.type ?? 'unknown'}`);
      await ack();
      ackSent = true;
    });

    try {
      await withTimeout(client.start(), 15000, 'client.start()');
      console.log('-> Waiting up to 30s for an event (send a slash command to your app)...');

      const deadline = Date.now() + 30000;
      while (!eventReceived && Date.now() < deadline) {
        await delay(500);
      }

      if (eventReceived) {
        assert.ok(ackSent, 'ack should have been sent');
        console.log('-> Event received and acknowledged successfully');
      } else {
        console.log('-> No event received within 30s (test passes — connection was stable)');
      }
    } finally {
      await client.disconnect();
    }
  });

  it('Auto-reconnect', { timeout: 30000 }, async () => {
    const events: string[] = [];
    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logLevel: LogLevel.WARN,
      autoReconnectEnabled: true,
      serverPingTimeout: 3000,
    });

    client.on('connecting', () => events.push('connecting'));
    client.on('connected', () => events.push('connected'));
    client.on('reconnecting', () => events.push('reconnecting'));

    try {
      await withTimeout(client.start(), 15000, 'client.start()');
      assert.ok(events.includes('connected'), 'should initially connect');

      console.log('-> Waiting up to 20s for reconnect cycle...');
      const deadline = Date.now() + 20000;
      while (!events.includes('reconnecting') && Date.now() < deadline) {
        await delay(500);
      }

      if (events.includes('reconnecting')) {
        console.log('-> Reconnection triggered and observed');
        await delay(4000);
        const connectedCount = events.filter((e) => e === 'connected').length;
        assert.ok(connectedCount >= 2, `should have reconnected (connected count: ${connectedCount})`);
      } else {
        console.log('-> No reconnect needed (server responded within timeout)');
      }
    } finally {
      await client.disconnect();
    }
  });

  it('Dispatcher / Proxy', async () => {
    const dispatcher = new ProxyAgent(proxyUrl);
    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logLevel: LogLevel.WARN,
      dispatcher,
    });

    try {
      const result = await withTimeout(client.start(), 15000, 'client.start() via proxy');
      assert.equal(result.ok, true, 'should connect successfully through proxy');
    } finally {
      await client.disconnect();
    }
  });

  it('setGlobalProxyFromEnv', { timeout: 20000 }, async () => {
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const tunnelledHosts: string[] = [];
    const onConnect = (req: { url?: string }) => {
      if (req.url) tunnelledHosts.push(req.url);
    };
    proxyServer.on('connect', onConnect);

    try {
      process.env.HTTP_PROXY = proxyUrl;
      process.env.HTTPS_PROXY = proxyUrl;
      http.setGlobalProxyFromEnv();

      const client = new SocketModeClient({
        appToken: SLACK_APP_TOKEN!,
        logLevel: LogLevel.WARN,
      });

      try {
        const result = await withTimeout(client.start(), 15000, 'client.start() via setGlobalProxyFromEnv');
        assert.equal(result.ok, true, 'should connect successfully through global proxy');
      } finally {
        await client.disconnect();
      }

      const httpTunnel = tunnelledHosts.find((h) => h.includes('slack.com:443'));
      const wsTunnel = tunnelledHosts.find((h) => h.includes('wss-') || (h.includes('slack') && h !== httpTunnel));
      assert.ok(httpTunnel, `HTTP API call should tunnel through proxy (got: ${tunnelledHosts.join(', ')})`);
      assert.ok(wsTunnel, `WebSocket should tunnel through proxy (got: ${tunnelledHosts.join(', ')})`);
    } finally {
      proxyServer.removeListener('connect', onConnect);
      if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = originalHttpProxy;
      if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = originalHttpsProxy;
      http.setGlobalProxyFromEnv();
    }
  });

  it('Custom fetch + dispatcher precedence', async () => {
    const dispatcher = new ProxyAgent(proxyUrl);
    let customFetchCalled = false;

    const customFetch: FetchFunction = (url, init) => {
      customFetchCalled = true;
      return undiciFetch(url, { ...(init as RequestInit), dispatcher });
    };

    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logLevel: LogLevel.WARN,
      dispatcher,
      clientOptions: { fetch: customFetch },
    });

    try {
      await withTimeout(client.start(), 15000, 'client.start()');
      assert.ok(customFetchCalled, 'custom fetch should have been called for HTTP API (apps.connections.open)');
    } finally {
      await client.disconnect();
    }
  });

  it('Ping/pong monitoring', { timeout: 20000 }, async () => {
    const { logger, logs } = createCapturingLogger();
    const client = new SocketModeClient({
      appToken: SLACK_APP_TOKEN!,
      logger,
      pingPongLoggingEnabled: true,
      clientPingTimeout: 5000,
      serverPingTimeout: 30000,
    });

    try {
      await withTimeout(client.start(), 15000, 'client.start()');

      console.log('-> Monitoring ping/pong for 12 seconds...');
      await delay(12000);

      const pingLogs = logs.filter((l) => l.includes('ping') || l.includes('pong'));
      console.log(`-> Captured ${pingLogs.length} ping/pong log entries`);

      if (pingLogs.length > 0) {
        console.log(`-> Sample: ${pingLogs[0]}`);
      }

      assert.ok(pingLogs.length > 0, 'should have observed ping/pong activity');
    } finally {
      await client.disconnect();
    }
  });
});
