import { afterEach, expect, test, vi } from "vitest";
import { createCdpClient } from "./browser-cdp.mjs";

afterEach(() => vi.useRealTimers());

test("Chrome disconnecting before its Browser.close reply completes shutdown", async () => {
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket);
  const closing = client.send("Browser.close");
  socket.onclose();
  await expect(closing).resolves.toEqual({ result: {} });
  await expect(client.send("Runtime.enable")).rejects.toThrow("DevTools is closed");
});

test("disconnects fail ordinary commands instead of reporting success", async () => {
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket);
  const pending = client.send("Runtime.evaluate");
  socket.onclose();
  await expect(pending).rejects.toThrow("DevTools disconnected during Runtime.evaluate");
});

test("an abrupt shutdown error followed by close still completes Browser.close", async () => {
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket);
  const closing = client.send("Browser.close");
  socket.onerror();
  socket.onclose();
  await expect(closing).resolves.toEqual({ result: {} });
});

test("a shutdown socket error without a close event still fails at its deadline", async () => {
  vi.useFakeTimers();
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket, { timeoutMs: 50 });
  const pending = expect(client.send("Browser.close")).rejects.toThrow("DevTools timed out: Browser.close");
  socket.onerror();
  await vi.advanceTimersByTimeAsync(50);
  await pending;
});

test("commands that never receive a reply fail within the deadline", async () => {
  vi.useFakeTimers();
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket, { timeoutMs: 50 });
  const pending = expect(client.send("Browser.close")).rejects.toThrow("DevTools timed out: Browser.close");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
});

test("replies and notifications retain their normal transport behavior", async () => {
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket);
  const handler = vi.fn();
  client.on("Runtime.exceptionThrown", handler);
  const pending = client.send("Runtime.evaluate", { expression: "6" });
  const command = JSON.parse(socket.send.mock.calls[0][0]);
  socket.onmessage({ data: JSON.stringify({ id: command.id, result: { value: 6 } }) });
  await expect(pending).resolves.toEqual({ id: command.id, result: { value: 6 } });
  socket.onmessage({ data: JSON.stringify({ method: "Runtime.exceptionThrown", params: { text: "error" } }) });
  expect(handler).toHaveBeenCalledWith({ text: "error" });
  socket.onclose();
});

test("long solve requests can use a bounded deadline longer than ordinary commands", async () => {
  vi.useFakeTimers();
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket, { timeoutMs: 50 });
  const pending = client.send("Runtime.callFunctionOn", {}, { timeoutMs: 200 });
  await vi.advanceTimersByTimeAsync(100);
  socket.onmessage({ data: JSON.stringify({ id: 1, result: { value: "six modes" } }) });
  await expect(pending).resolves.toMatchObject({ result: { value: "six modes" } });
  socket.onclose();
});

test("unknown notification names and non-callable targets cannot dispatch", () => {
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket);
  const handler = vi.fn();
  client.on("Runtime.exceptionThrown", handler);
  client.on("invalid-target", {});
  for (const method of ["constructor", "__proto__", "get", "unregistered", "invalid-target"]) {
    expect(() => socket.onmessage({ data: JSON.stringify({ method, params: {} }) })).not.toThrow();
  }
  expect(handler).not.toHaveBeenCalled();
  socket.onclose();
});

test("socket and synchronous send errors reject outstanding requests", async () => {
  const socket = { send: vi.fn() };
  const client = createCdpClient(socket);
  const pending = client.send("Runtime.enable");
  socket.onerror();
  await expect(pending).rejects.toThrow("DevTools socket failed during Runtime.enable");
  const error = new Error("send failed");
  await expect(createCdpClient({ send() { throw error; } }).send("Runtime.enable")).rejects.toBe(error);
});
