import express, { Express } from "express";
import { Server } from "http";
import { KLFInterface } from "./KLFInterface";

export class WebService {
  private readonly app: Express;
  private readonly klfInterface: KLFInterface;

  private httpServer?: Server;

  constructor(klfInterface: KLFInterface) {
    this.app = express();
    this.klfInterface = klfInterface;
  }

  public async listen(port = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      // TODO setup reject on first error!
      this.httpServer = this.app.listen(port, () => resolve); // TODO port and address?
    });
  }

  public registerRoutes(): void {
    this.app.get("/product/:node", (request, response) => {
      const nodeId = request.params.node;

      // action (UP DOWN STOP)
    });
  }

  public shutdown(): Promise<void> {
    if (!this.httpServer) {
      return Promise.resolve();
    }

    const httpServer = this.httpServer;

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
