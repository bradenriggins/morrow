import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";

const servers: Server[] = [];

async function listenOn(port: number): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("loopback port fixture", () => {
  it("reserves a port outside the range the operating system hands out on its own", async () => {
    const port = await reserveLoopbackPort();

    // Below 32768 keeps the port out of the ephemeral pool on both macOS and
    // Linux, so no unrelated outgoing socket can take it before the test does.
    expect(port).toBeGreaterThanOrEqual(1_024);
    expect(port).toBeLessThan(32_768);
    await expect(listenOn(port)).resolves.toBe(port);
  });

  it("never draws the port an installed Morrow uses", async () => {
    // The draw that lands on 32147, the connector's own default port, with half
    // a step added so the floor inside the fixture cannot fall to the port below.
    const random = vi.spyOn(Math, "random").mockReturnValue((32_147 - 20_480 + 0.5) / (32_767 - 20_480 + 1));
    try {
      await expect(reserveLoopbackPort()).resolves.toBe(32_148);
    } finally {
      random.mockRestore();
    }
  });

  it("skips a candidate another process holds and returns a free one", async () => {
    const free = await reserveLoopbackPort();
    const held = await listenOn(await reserveLoopbackPort());
    let attempt = 0;
    const candidate = (): number => {
      attempt += 1;
      return attempt <= 2 ? held : free;
    };

    await expect(reserveLoopbackPort({ candidate })).resolves.toBe(free);
    expect(attempt).toBe(3);
  });

  it("names every held port when no candidate is free", async () => {
    const held = await listenOn(await reserveLoopbackPort());

    await expect(reserveLoopbackPort({ attempts: 3, candidate: () => held })).rejects.toThrow(
      `no free loopback port after 3 attempts: ${held}, ${held}, ${held} are all in use on 127.0.0.1`,
    );
  });

  it("waits for a listener that starts after the first attempt", async () => {
    const port = await reserveLoopbackPort();
    const started = new Promise<void>((resolve) => {
      setTimeout(() => void listenOn(port).then(() => resolve()), 120);
    });

    await assertPortListening(port, 5_000);
    await started;
  });

  it("names the port when nothing takes it", async () => {
    const port = await reserveLoopbackPort();

    await expect(assertPortListening(port, 200)).rejects.toThrow(
      `nothing is listening on 127.0.0.1:${port} after 200 ms.`,
    );
  });
});
