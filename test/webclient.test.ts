import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import 'dotenv/config';
import {
  type ConversationsListResponse,
  ErrorCode,
  type FetchFunction,
  type FilesCompleteUploadExternalResponse,
  SlackError,
  WebAPIFileUploadInvalidArgumentsError,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from '@slack/web-api';
import { createProxy } from 'proxy';
import { Agent, ProxyAgent, type RequestInit, fetch as undiciFetch } from 'undici';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

describe('WebClient', () => {
  let proxyServer: Server;
  let proxyUrl: string;

  before(async () => {
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      throw new Error('SLACK_BOT_TOKEN and SLACK_CHANNEL_ID environment variables are required.');
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
  });

  it('auth.test', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(typeof result.user_id, 'string', 'user_id should be a string');
    assert.equal(typeof result.team_id, 'string', 'team_id should be a string');
    assert.equal(typeof result.bot_id, 'string', 'bot_id should be a string');
  });

  it('chat.postMessage (text)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = await client.chat.postMessage({
      channel: SLACK_CHANNEL_ID!,
      text: `[manual-verification] text message @ ${new Date().toISOString()}`,
    });
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(typeof result.ts, 'string', 'ts should be a string');
    assert.equal(typeof result.channel, 'string', 'channel should be returned');
  });

  it('chat.postMessage (blocks)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = await client.chat.postMessage({
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
    });
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(typeof result.ts, 'string', 'ts should be a string');
  });

  it('files.uploadV2 (Buffer)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const content = `Hello from manual verification @ ${new Date().toISOString()}`;
    const result = (await client.files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      content,
      filename: 'verification-buffer.txt',
      title: 'Buffer Upload Test',
    })) as { ok: boolean; files: FilesCompleteUploadExternalResponse[] };
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length > 0, 'should have at least one file');
  });

  it('files.uploadV2 (multiple)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = (await client.files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      file_uploads: [
        { content: 'File one content', filename: 'multi-file-1.txt', title: 'Multi 1' },
        { content: 'File two content', filename: 'multi-file-2.txt', title: 'Multi 2' },
      ],
    })) as { ok: boolean; files: FilesCompleteUploadExternalResponse[] };
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length >= 1, 'should have completed uploads');
  });

  it('files.uploadV2 (file path)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    const result = (await client.files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      file: import.meta.filename ?? new URL(import.meta.url).pathname,
      filename: 'webclient.test.ts',
      title: 'Verification Script Upload',
    })) as { ok: boolean; files: FilesCompleteUploadExternalResponse[] };
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length > 0, 'should have at least one file');
  });

  it('Pagination (conversations.list)', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    let pageCount = 0;
    const pages: ConversationsListResponse[] = [];

    for await (const page of client.paginate('conversations.list', { limit: 2 })) {
      pages.push(page);
      pageCount++;
      if (pageCount >= 3) break;
    }

    assert.ok(pageCount >= 1, 'should receive at least one page');
    const firstPage = pages[0];
    assert.equal(firstPage.ok, true, 'first page ok should be true');
    assert.ok(Array.isArray(firstPage.channels), 'channels should be an array');
  });

  it('Custom fetch / Proxy', async () => {
    const dispatcher = new ProxyAgent(proxyUrl);
    const proxyFetch: FetchFunction = (url, init) => undiciFetch(url, { ...(init as RequestInit), dispatcher });

    const client = new WebClient(SLACK_BOT_TOKEN, { fetch: proxyFetch });
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'auth.test should succeed through proxy');
    assert.equal(typeof result.user_id, 'string', 'user_id should be present');
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
      assert.ok(err instanceof WebAPIRequestError, 'should be instance of WebAPIRequestError');
      assert.equal(err.code, ErrorCode.RequestError, `expected RequestError, got ${err.code}`);
      assert.ok(err.original instanceof Error, 'should have .original Error attached');
    }
  });

  it('Error: PlatformError', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    try {
      await client.chat.postMessage({ channel: 'CINVALID999', text: 'should fail' });
      assert.fail('Should have thrown a PlatformError');
    } catch (err: unknown) {
      assert.ok(err instanceof WebAPIPlatformError, 'should be instance of WebAPIPlatformError');
      assert.equal(err.code, ErrorCode.PlatformError, `expected PlatformError, got ${err.code}`);
      assert.equal(typeof err.data.error, 'string', 'should have .data.error string');
      assert.ok(err.data.error.length > 0, 'error string should not be empty');
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
      assert.ok(err instanceof WebAPIRequestError, 'should be instance of WebAPIRequestError');
      assert.equal(err.code, ErrorCode.RequestError, `expected RequestError, got ${err.code}`);
      assert.ok(err.original instanceof Error, 'should have .original Error');
      assert.equal(err.original.message, 'Simulated network failure', 'original message should match');
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
      assert.ok(err instanceof WebAPIRateLimitedError, 'should be instance of WebAPIRateLimitedError');
      assert.equal(err.code, ErrorCode.RateLimitedError, `expected RateLimitedError, got ${err.code}`);
      assert.equal(err.retryAfter, 30, `retryAfter should be 30, got ${err.retryAfter}`);
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

  it('TLS via custom fetch (undici Agent)', async () => {
    const agent = new Agent({
      connect: { rejectUnauthorized: true },
    });
    const tlsFetch: FetchFunction = (url, init) => undiciFetch(url, { ...(init as RequestInit), dispatcher: agent });

    const client = new WebClient(SLACK_BOT_TOKEN, { fetch: tlsFetch });
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'auth.test should succeed with TLS agent');
    assert.equal(typeof result.user_id, 'string', 'user_id should be present');
    agent.close();
  });

  it('Request interceptor via fetch wrapper', async () => {
    const interceptedRequests: { url: string; method?: string }[] = [];

    const interceptingFetch: FetchFunction = (url, init) => {
      interceptedRequests.push({ url: url.toString(), method: init?.method });
      return globalThis.fetch(url, init);
    };

    const client = new WebClient(SLACK_BOT_TOKEN, { fetch: interceptingFetch });
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'auth.test should succeed through interceptor');
    assert.ok(interceptedRequests.length > 0, 'should have intercepted at least one request');
    assert.ok(interceptedRequests[0].url.includes('auth.test'), 'intercepted URL should contain auth.test');
    assert.equal(interceptedRequests[0].method, 'POST', 'method should be POST');
  });

  it('Mock adapter via custom fetch', async () => {
    const mockResponse = { ok: true, user_id: 'U_MOCK', team_id: 'T_MOCK', bot_id: 'B_MOCK' };

    const mockFetch: FetchFunction = () =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );

    const client = new WebClient('xoxb-mock-token', { fetch: mockFetch });
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(result.user_id, 'U_MOCK', 'should use mocked user_id');
    assert.equal(result.team_id, 'T_MOCK', 'should use mocked team_id');
  });

  it('Error: HTTPError headers are Record<string, string>', async () => {
    const httpErrorFetch: FetchFunction = () =>
      Promise.resolve(
        new Response('Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'x-custom-header': 'custom-value', 'content-type': 'text/plain' },
        }),
      );

    const client = new WebClient(SLACK_BOT_TOKEN, {
      fetch: httpErrorFetch,
      retryConfig: { retries: 0 },
    });

    try {
      await client.auth.test();
      assert.fail('Should have thrown an HTTPError');
    } catch (err: unknown) {
      assert.ok(err instanceof WebAPIHTTPError, 'should be instance of WebAPIHTTPError');
      assert.equal(err.code, ErrorCode.HTTPError, `expected HTTPError, got ${err.code}`);
      assert.equal(err.statusCode, 500, 'statusCode should be 500');
      assert.equal(typeof err.headers, 'object', 'headers should be an object');
      assert.equal(err.headers['x-custom-header'], 'custom-value', 'custom header should be a plain string');
      assert.equal(typeof err.headers['content-type'], 'string', 'content-type should be a string');
      assert.ok(!Array.isArray(err.headers['x-custom-header']), 'header value should not be an array');
    }
  });

  it('Exported Fetch types are usable', async () => {
    const myFetch: FetchFunction = (url, init) => globalThis.fetch(url, init);
    const client = new WebClient(SLACK_BOT_TOKEN, { fetch: myFetch });
    const result = await client.auth.test();
    assert.equal(result.ok, true, 'should work with FetchFunction-typed custom fetch');

    const nativeFetch: FetchFunction = globalThis.fetch;
    assert.equal(typeof nativeFetch, 'function', 'globalThis.fetch satisfies FetchFunction');
  });

  it('files.uploadV2 (Readable stream)', async () => {
    const content = `Stream upload verification @ ${new Date().toISOString()}`;
    const readable = Readable.from(Buffer.from(content));

    const result = (await new WebClient(SLACK_BOT_TOKEN).files.uploadV2({
      channel_id: SLACK_CHANNEL_ID!,
      file: readable,
      filename: 'verification-stream.txt',
      title: 'Readable Stream Upload Test',
    })) as { ok: boolean; files: FilesCompleteUploadExternalResponse[] };
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.ok(Array.isArray(result.files), 'result.files should be an array');
    assert.ok(result.files.length > 0, 'should have at least one file');
  });

  it('Redirect behavior (default error, custom allows follow)', async () => {
    const redirectFetch: FetchFunction = (url, init) => {
      assert.equal(init?.redirect, 'error', 'SDK should pass redirect: error by default');
      return globalThis.fetch(url, init);
    };

    const client1 = new WebClient(SLACK_BOT_TOKEN, { fetch: redirectFetch });
    const result1 = await client1.auth.test();
    assert.equal(result1.ok, true, 'should succeed and confirm redirect:error was passed');

    let overriddenRedirect: string | undefined;
    const followRedirectFetch: FetchFunction = (url, init) => {
      const modifiedInit = { ...init, redirect: 'follow' as RequestRedirect };
      overriddenRedirect = modifiedInit.redirect;
      return globalThis.fetch(url, modifiedInit);
    };

    const client2 = new WebClient(SLACK_BOT_TOKEN, { fetch: followRedirectFetch });
    const result2 = await client2.auth.test();
    assert.equal(result2.ok, true, 'should succeed with redirect:follow');
    assert.equal(overriddenRedirect, 'follow', 'redirect should have been overridden to follow');
  });

  it('Error: all WebAPI errors extend SlackError and have .message', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN, { retryConfig: { retries: 0 } });

    // PlatformError
    try {
      await client.chat.postMessage({ channel: 'CINVALID999', text: 'test' });
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof Error, 'PlatformError should be instance of Error');
      assert.ok(err instanceof SlackError, 'PlatformError should be instance of SlackError');
      assert.ok(err instanceof WebAPIPlatformError, 'should be WebAPIPlatformError');
      assert.equal(typeof err.message, 'string', 'message should be a string');
      assert.ok(err.message.length > 0, 'message should not be empty');
    }

    // RequestError
    const brokenClient = new WebClient(SLACK_BOT_TOKEN, {
      fetch: () => {
        throw new Error('network down');
      },
      retryConfig: { retries: 0 },
    });
    try {
      await brokenClient.auth.test();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof Error, 'RequestError should be instance of Error');
      assert.ok(err instanceof SlackError, 'RequestError should be instance of SlackError');
      assert.ok(err instanceof WebAPIRequestError, 'should be WebAPIRequestError');
      assert.equal(typeof err.message, 'string', 'message should be a string');
      assert.ok(err.message.length > 0, 'message should not be empty');
    }

    // HTTPError
    const httpClient = new WebClient(SLACK_BOT_TOKEN, {
      fetch: () => Promise.resolve(new Response('fail', { status: 500, statusText: 'Internal Server Error' })),
      retryConfig: { retries: 0 },
    });
    try {
      await httpClient.auth.test();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof Error, 'HTTPError should be instance of Error');
      assert.ok(err instanceof SlackError, 'HTTPError should be instance of SlackError');
      assert.ok(err instanceof WebAPIHTTPError, 'should be WebAPIHTTPError');
      assert.equal(typeof err.message, 'string', 'message should be a string');
      assert.ok(err.message.length > 0, 'message should not be empty');
    }

    // RateLimitedError
    const rateLimitClient = new WebClient(SLACK_BOT_TOKEN, {
      fetch: () => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '10' } })),
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
    });
    try {
      await rateLimitClient.auth.test();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof Error, 'RateLimitedError should be instance of Error');
      assert.ok(err instanceof SlackError, 'RateLimitedError should be instance of SlackError');
      assert.ok(err instanceof WebAPIRateLimitedError, 'should be WebAPIRateLimitedError');
      assert.equal(typeof err.message, 'string', 'message should be a string');
      assert.ok(err.message.length > 0, 'message should not be empty');
    }
  });

  it('Error: WebAPIFileUploadInvalidArgumentsError', async () => {
    const client = new WebClient(SLACK_BOT_TOKEN);
    try {
      await client.filesUploadV2({ file_uploads: [{}] } as any);
      assert.fail('Should have thrown a file upload invalid arguments error');
    } catch (err: unknown) {
      assert.ok(err instanceof SlackError, 'should be instance of SlackError');
      assert.ok(
        err instanceof WebAPIFileUploadInvalidArgumentsError,
        'should be WebAPIFileUploadInvalidArgumentsError',
      );
      assert.equal(err.code, ErrorCode.FileUploadInvalidArgumentsError);
    }
  });
});
