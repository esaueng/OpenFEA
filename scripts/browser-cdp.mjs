// Chrome may close its DevTools socket before replying to Browser.close.
// Bound every request and settle outstanding commands when the socket ends.
export function createCdpClient(socket, { timeoutMs = 30_000 } = {}) {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  let closed = false;
  function finish(id, error, response) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(response);
  }
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      finish(message.id, null, message);
      return;
    }
    const handler = handlers.get(message.method);
    if (typeof handler === "function") handler(message.params);
  };
  socket.onclose = () => {
    closed = true;
    for (const [id, request] of pending) {
      finish(id, request.method === "Browser.close" ? null : new Error(`DevTools disconnected during ${request.method}`), { result: {} });
    }
  };
  socket.onerror = () => {
    closed = true;
    for (const [id, request] of pending) {
      // An abrupt browser exit can emit error before close. Only the close
      // event completes Browser.close; a missing close still hits its deadline.
      if (request.method !== "Browser.close") finish(id, new Error(`DevTools socket failed during ${request.method}`));
    }
  };
  return {
    send(method, params = {}, { timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
      if (closed) return Promise.reject(new Error(`DevTools is closed: ${method}`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(id, new Error(`DevTools timed out: ${method}`)), requestTimeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { finish(id, error); }
      });
    },
    on(method, handler) { handlers.set(method, handler); }
  };
}
