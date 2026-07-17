export function buildHar({ entries, pages, startedDateTime }) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'browser-forge', version: '0.1.0' },
      pages,
      entries: entries.map(e => ({
        startedDateTime: e.startedDateTime ?? startedDateTime,
        time: e.time ?? -1,
        request: {
          method: e.request?.method ?? 'GET',
          url: e.request?.url ?? '',
          httpVersion: 'HTTP/1.1',
          headers: headersObjectToHar(e.request?.headers ?? {}),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.request?.postData ? Buffer.byteLength(e.request.postData) : 0,
          postData: e.request?.postData ? { mimeType: 'application/octet-stream', text: e.request.postData } : undefined
        },
        response: {
          status: e.response?.status ?? 0,
          statusText: e.response?.statusText ?? '',
          httpVersion: 'HTTP/1.1',
          headers: headersObjectToHar(e.response?.headers ?? {}),
          cookies: [],
          content: {
            size: e.body ? Buffer.byteLength(e.body) : -1,
            mimeType: e.response?.mimeType ?? 'application/octet-stream',
            text: e.bodyTooLarge ? undefined : e.body,
            comment: e.bodyTooLarge ? 'body_too_large' : undefined,
            encoding: e.bodyBase64 ? 'base64' : undefined
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1
        },
        cache: {},
        timings: { send: 0, wait: e.time ?? -1, receive: 0 }
      }))
    }
  }
}

function headersObjectToHar(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}
