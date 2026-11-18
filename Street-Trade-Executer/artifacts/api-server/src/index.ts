import "./lib/env";
import http from "http";
import app from "./app";
import { initWsServer } from "./lib/ws";
import { initDb } from "./lib/initDb";
import { startCryptoBotWorker } from "./lib/cryptoBotWorker";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] || "8090";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

initDb()
  .then(() => {
    const server = http.createServer(app);
    initWsServer(server);

    server.listen(port, (err?: Error) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
      startCryptoBotWorker();
    });
  })
  .catch((err) => {
    logger.error({ err }, "Database initialization failed - aborting");
    process.exit(1);
  });
