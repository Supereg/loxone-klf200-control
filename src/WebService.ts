import express, { Express } from "express";
import { Server } from "http";
import { AddressInfo } from "net";
import { Logger } from "winston";
import { KLFInterface } from "./KLFInterface";
import { RunCommandSession } from "./RunCommandSession";

export class WebService {
  private readonly logger: Logger;
  private readonly app: Express;
  private readonly klfInterface: KLFInterface;

  private httpServer?: Server;

  constructor(logger: Logger, klfInterface: KLFInterface) {
    this.logger = logger.child({ label: "WebService" });
    this.app = express();
    this.klfInterface = klfInterface;
  }

  public async listen(port = 0): Promise<void> { // TODO ability to supply hostname?
    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error) => {
        this.logger.debug("WebService failed to start with error: %s", error);
        reject(error);
      };

      this.httpServer = this.app.listen(port, () => {
        const address = this.httpServer!.address() as AddressInfo;
        this.logger.info(`WebService is running on ${address.address}:${address.port}`);

        this.httpServer!.removeListener("error", errorHandler);

        this.registerRoutes();
        resolve();
      });

      this.httpServer.once("error", errorHandler);
    });
  }

  private registerRoutes(): void {
    this.app.get("/product/:node", (request, response) => {
      // TODO do we need to end?
      const nodeId = parseInt(request.params.node); // TODO catch!
      const query = request.query;

      if (!query.command || typeof query.command !== "string") {
        this.logger.warning("Received request for product %d with missing `command` parameter!", nodeId);
        response
          .status(400)
          .json({ status: "error", error: "Query parameter 'command' missing or malformed!" });
        return;
      }

      // TODO When to register routes => enable queuing of commands (per node?)?
      let promise: Promise<RunCommandSession>;
      const command = query.command.toLowerCase();

      switch (command) {
      case "open":
        promise = this.klfInterface.open(nodeId);
        break;
      case "close":
        promise = this.klfInterface.close(nodeId);
        break;
      case "stop":
        promise = this.klfInterface.stop(nodeId);
        break;
      default:
        response
          .status(400)
          .json({ status: "error", error: "Query parameter 'command' has unsupported value. Choose from ['open', 'close', 'stop']!" });
        return;
      }

      this.logger.info("Received %s command for node %d...", command, nodeId);

      promise
        .then(() => {
          this.logger.info("Successfully completed %s command for node %d!", command, nodeId);
          response
            .status(200)
            .json({ status: "success" });
        }, reason => {
          // TODO flicker light on error!
          this.logger.warning("Failed to execute %s command for node %d: %s", command, nodeId, reason);

          response
            .status(500) // TODO error stuff?
            .json({ status: "error", error: reason });
        });
    });
  }

  public shutdown(): Promise<void> {
    if (!this.httpServer) {
      return Promise.resolve();
    }

    const httpServer = this.httpServer;

    // TODO connection end

    return new Promise((resolve, reject) => {
      httpServer.close(error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
