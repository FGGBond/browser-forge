export class NetworkCollector {
  constructor({ targetId, maxBodyBytes = 10_000_000 }) {
    this.targetId = targetId
    this.maxBodyBytes = maxBodyBytes
    this._entries = new Map()
  }

  onRequestWillBeSent({ requestId, request, timestamp, type }) {
    this._entries.set(requestId, {
      requestId,
      startedTimestamp: timestamp,
      type,
      request: { url: request.url, method: request.method, headers: request.headers, postData: request.postData },
      response: null,
      body: null,
      bodyTooLarge: false
    })
  }

  onResponseReceived({ requestId, response, timestamp }) {
    const entry = this._entries.get(requestId)
    if (!entry) return
    entry.response = {
      status: response.status,
      statusText: response.statusText ?? '',
      headers: response.headers,
      mimeType: response.mimeType,
      url: response.url
    }
    entry.responseTimestamp = timestamp
  }

  onLoadingFinished({ requestId }) {
    const entry = this._entries.get(requestId)
    if (entry) entry.loadingFinished = true
  }

  setBody(requestId, body, base64Encoded) {
    const entry = this._entries.get(requestId)
    if (!entry) return
    const bytes = base64Encoded ? Buffer.from(body, 'base64').length : Buffer.byteLength(body)
    if (bytes > this.maxBodyBytes) {
      entry.bodyTooLarge = true
    } else {
      entry.body = body
      entry.bodyBase64 = base64Encoded
    }
  }

  getEntries() {
    return Array.from(this._entries.values())
  }
}
