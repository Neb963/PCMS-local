import { createServer } from "node:net";

function parseSocksRequest(buffer) {
  if (buffer.length < 4) {
    return undefined;
  }
  if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) {
    return null;
  }

  const atyp = buffer[3];
  let offset = 4;
  let host;
  if (atyp === 1) {
    if (buffer.length < offset + 4 + 2) return undefined;
    host = [...buffer.subarray(offset, offset + 4)].join(".");
    offset += 4;
  } else if (atyp === 3) {
    if (buffer.length < offset + 1) return undefined;
    const length = buffer[offset];
    offset += 1;
    if (buffer.length < offset + length + 2) return undefined;
    host = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
  } else {
    return null;
  }

  if (buffer.length < offset + 2) return undefined;
  const port = buffer.readUInt16BE(offset);
  offset += 2;
  return { host, port, consumed: offset };
}

function jsonResponse(identity, requestedHost, requestedPort, requestedPath) {
  const body = JSON.stringify({
    routeIdentity: identity,
    requestedHost,
    requestedPort,
    requestedPath
  });
  return [
    "HTTP/1.1 200 OK",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Cache-Control: no-store",
    "Connection: close",
    "",
    body
  ].join("\r\n");
}

export async function startSyntheticSocksExit({
  routeIdentity,
  expectedHost = "pcms-egress.invalid",
  expectedPort = 80
}) {
  const observations = [];
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    let state = "greeting";
    let buffer = Buffer.alloc(0);
    let target = null;

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        if (state === "greeting") {
          if (buffer.length < 2) return;
          if (buffer[0] !== 5) {
            socket.destroy();
            return;
          }
          const methodCount = buffer[1];
          if (buffer.length < 2 + methodCount) return;
          const methods = buffer.subarray(2, 2 + methodCount);
          buffer = buffer.subarray(2 + methodCount);
          if (!methods.includes(0)) {
            socket.end(Buffer.from([5, 255]));
            return;
          }
          socket.write(Buffer.from([5, 0]));
          state = "connect";
          continue;
        }

        if (state === "connect") {
          const parsed = parseSocksRequest(buffer);
          if (parsed === undefined) return;
          if (parsed === null) {
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(parsed.consumed);
          target = Object.freeze({ host: parsed.host, port: parsed.port });
          if (parsed.host !== expectedHost || parsed.port !== expectedPort) {
            socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
            return;
          }
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          state = "http";
          continue;
        }

        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const request = buffer.subarray(0, headerEnd + 4).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        const firstLine = request.split("\r\n", 1)[0] ?? "";
        const match = /^GET\s+(\S+)\s+HTTP\/1\.[01]$/u.exec(firstLine);
        if (match === null || target === null) {
          socket.destroy();
          return;
        }
        const observation = Object.freeze({
          routeIdentity,
          requestedHost: target.host,
          requestedPort: target.port,
          requestedPath: match[1]
        });
        observations.push(observation);
        socket.end(
          jsonResponse(
            routeIdentity,
            target.host,
            target.port,
            match[1]
          )
        );
        state = "done";
        return;
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic SOCKS exit did not bind a TCP port");
  }

  return Object.freeze({
    routeIdentity,
    host: "127.0.0.1",
    port: address.port,
    expectedHost,
    expectedPort,
    observations,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
}

export async function observeSyntheticSocksEgress({
  proxyHost,
  proxyPort,
  targetHost = "pcms-egress.invalid",
  targetPort = 80,
  targetPath = "/identity"
}) {
  const { createConnection } = await import("node:net");
  const hostBytes = Buffer.from(targetHost, "utf8");
  if (hostBytes.length < 1 || hostBytes.length > 255) {
    throw new Error("Synthetic egress target hostname is out of range");
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: proxyHost, port: proxyPort });
    let phase = "greeting";
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error === null) resolve(value);
      else reject(error);
    };

    socket.setTimeout(5_000);
    socket.once("connect", () => {
      socket.write(Buffer.from([5, 1, 0]));
    });
    socket.on("timeout", () => {
      finish(new Error("Synthetic SOCKS exchange timed out"));
    });
    socket.on("error", (error) => {
      finish(error);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        if (phase === "greeting") {
          if (buffer.length < 2) return;
          const greeting = buffer.subarray(0, 2);
          buffer = buffer.subarray(2);
          if (!greeting.equals(Buffer.from([5, 0]))) {
            finish(new Error("Synthetic SOCKS exit rejected no-auth negotiation"));
            return;
          }

          const request = Buffer.alloc(7 + hostBytes.length);
          request.set([5, 1, 0, 3, hostBytes.length], 0);
          hostBytes.copy(request, 5);
          request.writeUInt16BE(targetPort, 5 + hostBytes.length);
          socket.write(request);
          phase = "connect";
          continue;
        }

        if (phase === "connect") {
          if (buffer.length < 10) return;
          const reply = buffer.subarray(0, 10);
          buffer = buffer.subarray(10);
          if (reply[0] !== 5 || reply[1] !== 0) {
            finish(new Error("Synthetic SOCKS exit rejected CONNECT"));
            return;
          }
          socket.write(
            `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`
          );
          phase = "http";
          continue;
        }

        return;
      }
    });
    socket.on("end", () => {
      if (settled) return;
      if (phase !== "http") {
        finish(new Error(`Synthetic SOCKS connection ended during ${phase}`));
        return;
      }
      const text = buffer.toString("utf8");
      const separator = text.indexOf("\r\n\r\n");
      if (separator < 0) {
        finish(new Error("Synthetic egress response omitted headers"));
        return;
      }
      try {
        finish(null, JSON.parse(text.slice(separator + 4)));
      } catch (error) {
        finish(error);
      }
    });
  });
}

