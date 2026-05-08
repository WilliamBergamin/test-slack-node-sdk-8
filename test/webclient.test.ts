import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import 'dotenv/config';
import {
  type AuthTestResponse,
  type ChatPostMessageResponse,
  type ConversationsListResponse,
  ErrorCode,
  type FetchFunction,
  type WebAPICallResult,
  WebClient,
  type WebClientOptions,
} from '@slack/web-api';
import { createProxy } from 'proxy';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const TLS_CA_PATH = process.env.TLS_CA_PATH;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;

describe('WebClient', () => {
  let proxyServer: Server;
  let proxyUrl: string;

  before(async () => {
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN and SLACK_CHANNEL_ID environment variables are required.');
    }
    proxyServer = createProxy(createServer());
    await new Promise<void>((resolve, reject) => {
      proxyServer.listen(0, '127.0.0.1', () => resolve());
      proxyServer.on('error', reject);
    });
    const addr = proxyServer.address() as { port: number };
    proxyUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((res, rej) => proxyServer.close((err) => (err ? rej(err) : res())));
  });

  it('Basic Construction', async () => {
    const client1 = new WebClient(SLACK_BOT_TOKEN);
    assert.ok(client1 instanceof WebClient, 'client1 should be instance of WebClient');
    assert.equal(client1.token, SLACK_BOT_TOKEN, 'token should match');
    assert.equal(client1.slackApiUrl, 'https://slack.com/api/', 'default slackApiUrl');

    const client2 = new WebClient();
    assert.ok(client2 instanceof WebClient, 'client without token should work');
    assert.equal(client2.token, undefined, 'token should be undefined');

    const client3 = new WebClient(SLACK_BOT_TOKEN, { slackApiUrl: 'https://example.com/api' });
    assert.equal(client3.slackApiUrl, 'https://example.com/api/', 'should add trailing slash');

    const customFetch: FetchFunction = globalThis.fetch;
    const _opts: WebClientOptions = { fetch: customFetch, timeout: 5000 };
  });

  it('auth.test', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = (await client.auth.test()) as AuthTestResponse;
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(typeof result.user_id, 'string', 'user_id should be a string');
    assert.equal(typeof result.team_id, 'string', 'team_id should be a string');
    assert.equal(typeof result.bot_id, 'string', 'bot_id should be a string');
  });

  it('chat.postMessage (text)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = (await client.chat.postMessage({
      channel: SLACK_CHANNEL_ID!,
      text: `[manual-verification] text message @ ${new Date().toISOString()}`,
    })) as ChatPostMessageResponse;
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(typeof result.ts, 'string', 'ts should be a string');
    assert.equal(typeof result.channel, 'string', 'channel should be returned');
  });

  it('chat.postMessage (blocks)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = (await client.chat.postMessage({
      channel: SLACK_CHANNEL_ID!,
      text: 'fallback text',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Manual verification* — blocks message @ ${new Date().toISOString()}` },
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: { type: 'plain_text', text: 'This verifies Block Kit serialization works with native fetch.' },
        },
      ],
    })) as ChatPostMessageResponse;
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(typeof result.ts, 'string', 'ts should be a string');
  });

  it('files.uploadV2 (Buffer)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const content = `Hello from manual verification @ ${new Date().toISOString()}`;
    const result = await client.files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      content,
      filename: 'verification-buffer.txt',
      title: 'Buffer Upload Test',
    });
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length > 0, 'should have at least one file');
  });

  it('files.uploadV2 (multiple)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = await client.files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      file_uploads: [
        { content: 'File one content', filename: 'multi-file-1.txt', title: 'Multi 1' },
        { content: 'File two content', filename: 'multi-file-2.txt', title: 'Multi 2' },
      ],
    });
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length >= 1, 'should have completed uploads');
  });

  it('files.uploadV2 (file path)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = await client.files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      file: import.meta.filename ?? new URL(import.meta.url).pathname,
      filename: 'webclient.test.ts',
      title: 'Verification Script Upload',
    });
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length > 0, 'should have at least one file');
  });

  it('Pagination (conversations.list)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    let pageCount = 0;
    const pages: WebAPICallResult[] = [];

    for await (const page of client.paginate('conversations.list', { limit: 2 })) {
      pages.push(page);
      pageCount++;
      if (pageCount >= 3) break;
    }

    assert.ok(pageCount >= 1, 'should receive at least one page');
    const firstPage = pages[0] as ConversationsListResponse;
    assert.equal(firstPage.ok, true, 'first page ok should be true');
    assert.ok(Array.isArray(firstPage.channels), 'channels should be an array');
  });

  it('Custom fetch / Proxy', async () => {
    const dispatcher = new ProxyAgent(proxyUrl);
    const proxyFetch: FetchFunction = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        {
          ...init,
          dispatcher,
        } as Parameters<typeof undiciFetch>[1],
      )) as unknown as FetchFunction;

    const client = new WebClient(SLACK_BOT_TOKEN, { fetch: proxyFetch });
    const result = (await client.auth.test()) as AuthTestResponse;
    assert.equal(result.ok, true, 'auth.test should succeed through proxy');
    assert.equal(typeof result.user_id, 'string', 'user_id should be present');
  });

  it('TLS configuration', {
    skip: !(TLS_CA_PATH && TLS_CERT_PATH && TLS_KEY_PATH) && 'TLS_CA_PATH/TLS_CERT_PATH/TLS_KEY_PATH not set',
  }, async () => {
    const dispatcher = new Agent({
      connect: {
        ca: readFileSync(TLS_CA_PATH!),
        cert: readFileSync(TLS_CERT_PATH!),
        key: readFileSync(TLS_KEY_PATH!),
      },
    });
    const tlsFetch: FetchFunction = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        {
          ...init,
          dispatcher,
        } as Parameters<typeof undiciFetch>[1],
      )) as unknown as FetchFunction;

    const client = new WebClient(SLACK_BOT_TOKEN, { fetch: tlsFetch });
    const result = (await client.auth.test()) as AuthTestResponse;
    assert.equal(result.ok, true, 'auth.test should succeed with TLS config');
  });

  it('Timeout handling', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN, {
      timeout: 1,
      retryConfig: { retries: 0 },
    });
    try {
      await client.auth.test();
      assert.fail('Should have thrown a timeout error');
    } catch (err: unknown) {
      const error = err as { code?: string; original?: Error };
      assert.equal(error.code, ErrorCode.RequestError, `expected RequestError, got ${error.code}`);
      assert.ok(error.original instanceof Error, 'should have .original Error attached');
    }
  });

  it('Error: PlatformError', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    try {
      await client.chat.postMessage({ channel: 'CINVALID999', text: 'should fail' });
      assert.fail('Should have thrown a PlatformError');
    } catch (err: unknown) {
      const error = err as { code?: string; data?: { error: string } };
      assert.equal(error.code, ErrorCode.PlatformError, `expected PlatformError, got ${error.code}`);
      assert.equal(typeof error.data?.error, 'string', 'should have .data.error string');
      assert.ok(error.data!.error.length > 0, 'error string should not be empty');
    }
  });

  it('Error: RequestError', async () => {
    const brokenFetch: FetchFunction = () => {
      throw new Error('Simulated network failure');
    };
    const client = new WebClient(SLACK_BOT_TOKEN, {
      fetch: brokenFetch,
      retryConfig: { retries: 0 },
    });
    try {
      await client.auth.test();
      assert.fail('Should have thrown a RequestError');
    } catch (err: unknown) {
      const error = err as { code?: string; original?: Error };
      assert.equal(error.code, ErrorCode.RequestError, `expected RequestError, got ${error.code}`);
      assert.ok(error.original instanceof Error, 'should have .original Error');
      assert.equal(error.original!.message, 'Simulated network failure', 'original message should match');
    }
  });

  it('Error: RateLimitedError (simulated)', async () => {
    const rateLimitFetch: FetchFunction = () => {
      return Promise.resolve(
        new Response('', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
      );
    };
    const client = new WebClient(SLACK_BOT_TOKEN, {
      fetch: rateLimitFetch,
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
    });
    try {
      await client.auth.test();
      assert.fail('Should have thrown a RateLimitedError');
    } catch (err: unknown) {
      const error = err as { code?: string; retryAfter?: number };
      assert.equal(error.code, ErrorCode.RateLimitedError, `expected RateLimitedError, got ${error.code}`);
      assert.equal(error.retryAfter, 30, `retryAfter should be 30, got ${error.retryAfter}`);
    }
  });

  it('Custom headers', async () => {
    let capturedHeaders: Record<string, string> = {};

    const capturingFetch: FetchFunction = (input, init) => {
      const headers = init?.headers;
      if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        capturedHeaders = { ...(headers as Record<string, string>) };
      }
      return globalThis.fetch(input, init);
    };

    const client = new WebClient(SLACK_BOT_TOKEN, {
      fetch: capturingFetch,
      headers: { 'X-Custom-Header': 'verification-value' },
    });
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'auth.test should succeed');
    assert.equal(capturedHeaders['X-Custom-Header'], 'verification-value', 'custom header should be present');
    assert.ok(capturedHeaders['User-Agent'] !== undefined, 'User-Agent header should be present');
    assert.ok(capturedHeaders.Authorization?.startsWith('Bearer '), 'Authorization header should be set');
  });
});
