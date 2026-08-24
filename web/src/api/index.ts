import { isEasyEda } from "../eda/utils";
import { getUserAuth } from "../eda/user";
import { type EventSourceMessage, EventStreamContentType, fetchEventSource } from './fetch-sse/index';
import { __MODE__ } from "@copilot/shared/mode";

type MyRequestInit = Omit<RequestInit, 'body'> & { body?: string | Blob | FormData | URLSearchParams | undefined };

type FetchWithTaskInput = {
    url: string;
    body: object | string;
    fetchOptions: MyRequestInit;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: ((s: string) => void);
}

type FetchWithSSE = {
    url: string;
    body: object | string;
    signal?: AbortSignal;
    prevStreamId?: string;
    prevLastEventId?: string;

    onopen?: (response: Response, streamId?: string) => Promise<void>;
    onmessage?: (ev: EventSourceMessage) => void;
    onclose?: () => void;
    onerror?: (err: unknown) => number | null | undefined | void;
}

export async function fetchEda(
    input: string | URL | Request,
    init?: MyRequestInit
) {
    if (!isEasyEda()) return fetch(input, init);

    const url = typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.href
            : input.url;

    const method = (init?.method || 'GET').toUpperCase() as "GET" | "POST" | "HEAD" | "PUT" | "DELETE" | "PATCH";
    if (!['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        throw new TypeError(`Unsupported method: ${method}`);
    }

    let data;
    if (init?.body !== undefined) {
        if (typeof init.body === 'string' || init.body instanceof Blob || init.body instanceof FormData || init.body instanceof URLSearchParams) {
            data = init.body;
        } else {
            data = JSON.stringify(init.body);
            if (!init.headers || !('content-type' in init.headers) && !('Content-Type' in init.headers)) {
                init.headers = { ...init.headers, 'Content-Type': 'application/json' };
            }
        }
    }

    return await eda.sys_ClientUrl.request(url, method, data, { headers: init?.headers, integrity: init?.integrity });
}

export async function fetchWithTask({
    url,
    body,
    fetchOptions = {},
    pollIntervalMs = 2000,
    timeoutMs = Infinity,
    onProgress = undefined,
}: FetchWithTaskInput) {
    onProgress?.('Connecting...');

    const startRes = await fetchEda(apiUrl + url + '/start', {
        ...fetchOptions,

        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...fetchOptions.headers,
            'Authorization': authorization,
            'x-eda-user': getUserAuth(),
        },

        body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    if (!startRes.ok) {
        const text = await startRes.text();
        throw new Error(`Failed to start operation: ${startRes.status} ${text}`);
    }

    const { operationId } = await startRes.json();
    if (!operationId) throw new Error('Missing operationId');

    const statusUrl = `${apiUrl}${url}/status/${encodeURIComponent(operationId)}`;
    const cancelUrl = `${apiUrl}${url}/cancel/${encodeURIComponent(operationId)}`;
    const startTime = Date.now();
    let lastStatusUpdateTime = startTime;
    let lastProgressMessage = 'Processing...';
    const noUpdateTimeoutMs = 5000;

    const signal: AbortSignal | null | undefined = fetchOptions?.signal;
    let abortHandler: (() => Promise<void>) | undefined;
    if (signal) {
        abortHandler = async () => {
            try {
                await fetchEda(cancelUrl, { headers: { 'Authorization': authorization } });
            } catch (err) {
                console.error('Failed to cancel operation:', err);
            }
        };
        if (signal.aborted) {
            await abortHandler();
            throw new Error('Operation aborted');
        }
        signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
        while (true) {
            if (signal?.aborted) throw new Error('Operation aborted');
            if (Date.now() - startTime > timeoutMs) throw new Error(`Operation timed out after ${timeoutMs} ms`);

            const statusRes = await fetchEda(statusUrl, { ...fetchOptions, headers: { 'Authorization': authorization, ...fetchOptions.headers } });
            if (!statusRes.ok) {
                if (statusRes.status === 404) {
                    await new Promise((res, rej) => {
                        const t = setTimeout(() => res(undefined), pollIntervalMs);
                        if (signal) {
                            signal.addEventListener('abort', () => {
                                clearTimeout(t);
                                rej(new Error('Operation aborted'));
                            }, { once: true });
                        }
                    });
                    continue;
                }
                const text = await statusRes.text();
                throw new Error(`Status check failed: ${statusRes.status} ${text}`);
            }

            const op: { status: string, result: any, error: string, intermediateResult: { action: string } } = await statusRes.json();
            const currentAction = op?.intermediateResult?.action;

            if (currentAction && currentAction !== lastProgressMessage) {
                onProgress?.(currentAction);
                lastStatusUpdateTime = Date.now();
                lastProgressMessage = currentAction;
            } else {
                const timeSinceLastUpdate = Date.now() - lastStatusUpdateTime;
                if (timeSinceLastUpdate > noUpdateTimeoutMs) {
                    const elapsedSeconds = Math.round((Date.now() - lastStatusUpdateTime) / 1000);
                    onProgress?.(`${lastProgressMessage} (${elapsedSeconds}s)`);
                }
            }

            if (op.status === 'completed') {
                if (op.result === undefined) throw new Error('Result missing');
                return op.result;
            }
            if (op.status === 'failed') throw new Error(op.error || 'Operation failed');
            await new Promise(res => setTimeout(res, pollIntervalMs));
        }
    } finally {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
}

export async function fetchSSE({
    url, body,
    signal, onclose, onerror, onmessage, onopen
}: FetchWithSSE) {

    return fetchEventSource(apiUrl + url, {
        method: 'POST',
        fetch: fetchEda as never,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': authorization,
            'x-eda-user': getUserAuth(),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        openWhenHidden: true,
        signal: signal,
        onclose: () => onclose?.(),
        onerror: (e) => {
            onerror?.(e);
            throw new Error(e);
        },
        onmessage: (msg) => {
            if (msg.event === 'FatalError' || msg.event === 'error') {
                let errMes: string;
                try { errMes = JSON.parse(msg.data).error || "Server error"; }
                catch (e) { errMes = msg.data || "Server error"; }
                throw new Error(errMes);
            }
            onmessage?.(msg)
        },
        async onopen(response) {
            if (response.ok && response.headers.get('content-type')?.includes(EventStreamContentType)) {
                await onopen?.(response)
                return;
            } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                throw new Error('Fail to connect');
            } else if (response.status === 500) {
                const json = await response.json();
                throw new Error(json.error || 'Operation failed');
            } else {
                throw new Error('Fail to connect');
            }
        },
    });
}

export async function fetchSSETask({
    url, body, prevStreamId, prevLastEventId,
    signal, onclose, onerror, onmessage, onopen
}: FetchWithSSE) {
    let streamId;

    if (!prevStreamId) {
        const startRes = await fetchEda(apiUrl + url + '/new', {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authorization,
                'x-eda-user': getUserAuth(),
            },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });

        if (!startRes.ok) {
            const json = await startRes.json();
            throw new Error(`Failed to start stream ${startRes.status}: ${json.error}`);
        }

        const startJson = await startRes.json();
        streamId = startJson.streamId;
        if (!streamId) throw new Error('Missing streamId in start response');
    }
    else {
        streamId = prevStreamId;
    }

    const streamUrl = apiUrl + url + '/' + encodeURIComponent(streamId);
    let stopReceived = false;
    let abortHandler: (() => Promise<void>) | undefined;
    if (signal) {
        abortHandler = async () => {
            try {
                stopReceived = true;
                await fetchEda(`${apiUrl}${url}/${encodeURIComponent(streamId)}/stop`, {
                    method: 'POST',
                    headers: { 'Authorization': authorization },
                });
            } catch (err) {
                console.error('Failed to stop stream:', err);
            }
        };
        if (signal.aborted) {
            await abortHandler();
            throw new Error('Operation aborted');
        }
        signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
        let attempts = 0;
        let lastEventId: string | undefined = prevLastEventId;

        while (attempts < 3 && !stopReceived) {
            try {
                let currentUrl = streamUrl;
                if (lastEventId) currentUrl += `?last-event-id=${lastEventId}`

                await fetchEventSource(currentUrl, {
                    method: 'GET',
                    fetch: fetchEda as never,
                    headers: {
                        'Authorization': authorization,
                        'x-eda-user': getUserAuth(),
                    },
                    openWhenHidden: true,
                    signal: signal,
                    onclose: () => onclose?.(),
                    onerror: (e) => {
                        onerror?.(e);
                        throw e;
                    },
                    onmessage: (msg) => {
                        if (msg.id) lastEventId = msg.id;
                        attempts = 0;

                        if (msg.event === 'FatalError' || msg.event === 'error') {
                            let errMes: string;
                            try { errMes = JSON.parse(msg.data).error || "Server error"; }
                            catch (e) { errMes = msg.data || "Server error"; }
                            stopReceived = true;
                            throw new Error(errMes);
                        }

                        if (msg.event === 'end') stopReceived = true;
                        onmessage?.(msg)
                    },
                    async onopen(response) {
                        if (response.ok && response.headers.get('content-type')?.includes(EventStreamContentType)) {
                            await onopen?.(response, streamId)
                            return;
                        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                            throw new Error('Fail to connect');
                        } else if (response.status === 500) {
                            const json = await response.json();
                            throw new Error(json.error || 'Operation failed');
                        } else {
                            throw new Error('Fail to connect');
                        }
                    },
                });

                await new Promise<void>((resolve) => setTimeout(resolve, 1000))
                if (stopReceived) break;
                attempts++;
            } catch (err) {
                attempts++;
                if (signal?.aborted) throw err;
                if (attempts >= 3 || stopReceived) throw err;
                await new Promise(res => setTimeout(res, 1000));
            }
        }

        return;
    } finally {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
}

// This fork intentionally routes the integrated EasyEDA Copilot UI to the local
// Codex bridge. Authentication is provided by the existing Codex/ChatGPT login,
// so no OpenAI API key or EasyEDA cloud login is required for chat.
export const apiUrl = __MODE__ === 'DEV' ? 'http://localhost:5120' : 'http://127.0.0.1:8790';
export const authorization = 'Basic Y2lyY3VpdDp4eU9BTE5INHBmb05HNjB2VmtBNTg0MTg=';